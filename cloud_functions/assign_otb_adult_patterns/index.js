const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

const BUCKET_NAME = process.env.TRACKER_BUCKET || 'ey-otb-adult-pattern-tracker-202607';
const TRACKER_FILE = process.env.TRACKER_FILE || 'adult_expansion_2026_07/pattern_assignments.json';
const WAVE_LABEL = process.env.WAVE_LABEL || 'adult_expansion_86_to_120_2026_07';
const STALE_RESERVATION_MS = Number(process.env.STALE_RESERVATION_MINUTES || 20) * 60 * 1000;

const TARGETED_PAIRS = [
  ...Array(20).fill(['ABB', 'AAB']),
  ...Array(9).fill(['ABB', 'alternating']),
  ...Array(4).fill(['AAB', 'alternating']),
  ['ABB', 'random']
];

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

function sanitizeParticipantId(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
}

function iso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function parseMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function shufflePair(pair, seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2 === 0 ? pair.slice() : pair.slice().reverse();
}

function emptyTracker() {
  return {
    wave: WAVE_LABEL,
    createdAtIso: iso(),
    staleReservationMinutes: STALE_RESERVATION_MS / 60000,
    targetSlots: {
      adults: TARGETED_PAIRS.length,
      sessionPatternAdditions: {
        ABB: 30,
        AAB: 24,
        alternating: 13,
        random: 1,
        AABB: 0
      }
    },
    slots: {},
    assignments: {}
  };
}

function normalizeTracker(tracker) {
  tracker.wave ||= WAVE_LABEL;
  tracker.slots ||= {};
  tracker.assignments ||= {};
  tracker.staleReservationMinutes = STALE_RESERVATION_MS / 60000;

  // Backfill the first tracker version, which stored only assignments.
  for (const [participantID, assignment] of Object.entries(tracker.assignments)) {
    if (assignment && Number.isInteger(assignment.slotIndex)) {
      const slotKey = String(assignment.slotIndex);
      tracker.slots[slotKey] ||= {
        slotIndex: assignment.slotIndex,
        scheduleIndex: assignment.scheduleIndex,
        targetPair: TARGETED_PAIRS[assignment.scheduleIndex] || assignment.patterns,
        attempts: []
      };
      const slot = tracker.slots[slotKey];
      slot.currentParticipantID ||= participantID;
      slot.status ||= assignment.status || 'assigned';
      slot.assignedAtIso ||= assignment.assignedAtIso;
      slot.lastSeenAtIso ||= assignment.lastSeenAtIso || assignment.assignedAtIso;
      if (!slot.attempts.some(attempt => attempt.participantID === participantID)) {
        slot.attempts.push({
          participantID,
          patterns: assignment.patterns,
          status: assignment.status || 'assigned',
          assignedAtIso: assignment.assignedAtIso,
          lastSeenAtIso: assignment.lastSeenAtIso || assignment.assignedAtIso
        });
      }
    }
  }

  delete tracker.nextSlotIndex;
  return tracker;
}

async function readTracker(file) {
  try {
    const [contents] = await file.download();
    const [metadata] = await file.getMetadata();
    return {
      tracker: normalizeTracker(JSON.parse(contents.toString('utf8'))),
      generation: Number(metadata.generation)
    };
  } catch (error) {
    if (error.code === 404) {
      return { tracker: emptyTracker(), generation: 0 };
    }
    throw error;
  }
}

async function saveTracker(file, tracker, generation) {
  await file.save(JSON.stringify(tracker, null, 2), {
    resumable: false,
    contentType: 'application/json',
    preconditionOpts: { ifGenerationMatch: generation }
  });
}

function updateAttempt(slot, participantID, patch) {
  slot.attempts ||= [];
  const attempt = [...slot.attempts].reverse().find(item => item.participantID === participantID);
  if (attempt) {
    Object.assign(attempt, patch);
  }
}

function expireStaleReservations(tracker, nowMs) {
  for (const slot of Object.values(tracker.slots || {})) {
    if (!slot.currentParticipantID || slot.status === 'completed') {
      continue;
    }

    const lastSeenMs = parseMs(slot.lastSeenAtIso || slot.assignedAtIso);
    if (lastSeenMs && nowMs - lastSeenMs <= STALE_RESERVATION_MS) {
      continue;
    }

    const participantID = slot.currentParticipantID;
    const assignment = tracker.assignments[participantID];
    const staleAtIso = iso(nowMs);

    slot.status = 'stale';
    slot.staleAtIso = staleAtIso;
    slot.previousParticipantID = participantID;
    slot.currentParticipantID = null;
    updateAttempt(slot, participantID, { status: 'stale', staleAtIso });

    if (assignment && assignment.status !== 'completed') {
      assignment.status = 'stale';
      assignment.staleAtIso = staleAtIso;
    }
  }
}

function findAvailableSlot(tracker) {
  for (let slotIndex = 0; slotIndex < TARGETED_PAIRS.length; slotIndex++) {
    const slot = tracker.slots[String(slotIndex)];
    if (!slot || !slot.currentParticipantID || slot.status === 'stale') {
      return slotIndex;
    }
  }
  return -1;
}

function publicAssignment(participantID, assignment, reused) {
  return {
    participantID,
    wave: assignment.wave,
    slotIndex: assignment.slotIndex,
    scheduleIndex: assignment.scheduleIndex,
    patterns: assignment.patterns,
    status: assignment.status,
    assignedAtIso: assignment.assignedAtIso,
    lastSeenAtIso: assignment.lastSeenAtIso,
    completedAtIso: assignment.completedAtIso,
    staleAtIso: assignment.staleAtIso,
    staleReservationMinutes: STALE_RESERVATION_MS / 60000,
    reused
  };
}

function reserveSlot(tracker, participantID, nowMs) {
  const existing = tracker.assignments[participantID];
  if (existing && existing.status !== 'stale') {
    if (existing.status !== 'completed') {
      existing.status = 'active';
      existing.lastSeenAtIso = iso(nowMs);
      const slot = tracker.slots[String(existing.slotIndex)];
      if (slot?.currentParticipantID === participantID) {
        slot.status = 'active';
        slot.lastSeenAtIso = existing.lastSeenAtIso;
        updateAttempt(slot, participantID, { status: 'active', lastSeenAtIso: existing.lastSeenAtIso });
      }
    }
    return publicAssignment(participantID, existing, true);
  }

  const slotIndex = findAvailableSlot(tracker);
  if (slotIndex < 0) {
    return null;
  }

  const scheduleIndex = slotIndex % TARGETED_PAIRS.length;
  const slotKey = String(slotIndex);
  const slot = tracker.slots[slotKey] || {
    slotIndex,
    scheduleIndex,
    targetPair: TARGETED_PAIRS[scheduleIndex],
    attempts: []
  };

  const attemptIndex = slot.attempts.length;
  const nowIso = iso(nowMs);
  const patterns = shufflePair(TARGETED_PAIRS[scheduleIndex], `${participantID}:${slotIndex}:${attemptIndex}`);
  const assignment = {
    wave: WAVE_LABEL,
    slotIndex,
    scheduleIndex,
    attemptIndex,
    patterns,
    status: 'assigned',
    assignedAtIso: nowIso,
    lastSeenAtIso: nowIso
  };

  slot.currentParticipantID = participantID;
  slot.status = 'assigned';
  slot.assignedAtIso = nowIso;
  slot.lastSeenAtIso = nowIso;
  slot.completedAtIso = null;
  slot.staleAtIso = null;
  slot.attempts.push({
    participantID,
    patterns,
    status: 'assigned',
    assignedAtIso: nowIso,
    lastSeenAtIso: nowIso
  });

  tracker.slots[slotKey] = slot;
  tracker.assignments[participantID] = assignment;
  return publicAssignment(participantID, assignment, false);
}

function markAssignment(tracker, participantID, action, nowMs) {
  const assignment = tracker.assignments[participantID];
  if (!assignment) {
    return { ok: false, status: 404, message: 'No assignment found for participantID' };
  }

  const slot = tracker.slots[String(assignment.slotIndex)];
  const nowIso = iso(nowMs);

  if (action === 'complete') {
    assignment.status = 'completed';
    assignment.completedAtIso = nowIso;
    assignment.lastSeenAtIso = nowIso;
    if (slot?.currentParticipantID === participantID) {
      slot.status = 'completed';
      slot.completedAtIso = nowIso;
      slot.lastSeenAtIso = nowIso;
      updateAttempt(slot, participantID, { status: 'completed', completedAtIso: nowIso, lastSeenAtIso: nowIso });
    }
    return { ok: true, assignment: publicAssignment(participantID, assignment, true) };
  }

  if (assignment.status === 'completed') {
    return { ok: true, assignment: publicAssignment(participantID, assignment, true) };
  }

  assignment.status = action === 'close' ? 'closed' : 'active';
  assignment.lastSeenAtIso = nowIso;
  if (action === 'close') {
    assignment.closedAtIso = nowIso;
  }

  if (slot?.currentParticipantID === participantID) {
    slot.status = assignment.status;
    slot.lastSeenAtIso = nowIso;
    if (action === 'close') {
      slot.closedAtIso = nowIso;
    }
    updateAttempt(slot, participantID, {
      status: assignment.status,
      lastSeenAtIso: nowIso,
      ...(action === 'close' ? { closedAtIso: nowIso } : {})
    });
  }

  return { ok: true, assignment: publicAssignment(participantID, assignment, true) };
}

exports.assignOtbAdultPatterns = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const participantID = sanitizeParticipantId(req.body?.participantID || req.body?.participantId);
  if (!participantID) {
    return res.status(400).send('Missing participantID');
  }

  const action = String(req.body?.action || 'assign').toLowerCase();
  const file = storage.bucket(BUCKET_NAME).file(TRACKER_FILE);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { tracker, generation } = await readTracker(file);
    const nowMs = Date.now();
    expireStaleReservations(tracker, nowMs);

    let responsePayload;
    if (action === 'assign') {
      responsePayload = reserveSlot(tracker, participantID, nowMs);
      if (!responsePayload) {
        return res.status(409).json({
          error: 'No assignment slots are currently available',
          wave: WAVE_LABEL,
          staleReservationMinutes: STALE_RESERVATION_MS / 60000
        });
      }
    } else if (action === 'heartbeat' || action === 'active' || action === 'close' || action === 'complete') {
      const result = markAssignment(tracker, participantID, action, nowMs);
      if (!result.ok) {
        return res.status(result.status).send(result.message);
      }
      responsePayload = result.assignment;
    } else {
      return res.status(400).send(`Unknown action: ${action}`);
    }

    tracker.updatedAtIso = iso(nowMs);

    try {
      await saveTracker(file, tracker, generation);
      return res.status(200).json(responsePayload);
    } catch (error) {
      if (error.code === 412 || error.code === 409) {
        continue;
      }
      throw error;
    }
  }

  return res.status(503).send('Could not update assignment tracker; please retry.');
};
