const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

const BUCKET_NAME = process.env.TRACKER_BUCKET || 'ey-otb-adult-pattern-tracker-202607';
const TRACKER_FILE = process.env.TRACKER_FILE || 'adult_expansion_2026_07/pattern_assignments.json';
const WAVE_LABEL = process.env.WAVE_LABEL || 'adult_expansion_86_to_120_2026_07';

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
    createdAtIso: new Date().toISOString(),
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
    nextSlotIndex: 0,
    assignments: {}
  };
}

async function readTracker(file) {
  try {
    const [contents] = await file.download();
    const [metadata] = await file.getMetadata();
    return {
      tracker: JSON.parse(contents.toString('utf8')),
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

exports.assignOtbAdultPatterns = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const participantId = sanitizeParticipantId(req.body?.participantID || req.body?.participantId);
  if (!participantId) {
    return res.status(400).send('Missing participantID');
  }

  const file = storage.bucket(BUCKET_NAME).file(TRACKER_FILE);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { tracker, generation } = await readTracker(file);

    if (tracker.assignments?.[participantId]) {
      return res.status(200).json({
        participantID: participantId,
        ...tracker.assignments[participantId],
        reused: true
      });
    }

    tracker.assignments ||= {};
    const slotIndex = tracker.nextSlotIndex || 0;
    const scheduleIndex = slotIndex % TARGETED_PAIRS.length;
    const pair = shufflePair(TARGETED_PAIRS[scheduleIndex], `${participantId}:${slotIndex}`);

    const assignment = {
      wave: WAVE_LABEL,
      slotIndex,
      scheduleIndex,
      patterns: pair,
      assignedAtIso: new Date().toISOString()
    };

    tracker.assignments[participantId] = assignment;
    tracker.nextSlotIndex = slotIndex + 1;
    tracker.updatedAtIso = assignment.assignedAtIso;

    try {
      await saveTracker(file, tracker, generation);
      return res.status(200).json({
        participantID: participantId,
        ...assignment,
        reused: false
      });
    } catch (error) {
      if (error.code === 412 || error.code === 409) {
        continue;
      }
      throw error;
    }
  }

  return res.status(503).send('Could not reserve assignment slot; please retry.');
};
