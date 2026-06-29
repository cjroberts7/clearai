import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ALLOWED_COUNTRIES = ['UK', 'EU member state', 'United States', 'Canada', 'Australia', 'Middle East', 'Asia Pacific', 'Other'];

const DEPT_COUNTRY_REGULATIONS = {
  'UK': ['UK GDPR', 'ICO AI guidance', 'UK AI principles'],
  'EU member state': ['EU AI Act', 'GDPR', 'EU AI literacy obligations (Article 4)'],
  'United States': ['US state AI laws', 'FTC AI guidance', 'CCPA (if California)'],
  'Canada': ['PIPEDA', 'Bill C-27 (AI and Data Act)'],
  'Australia': ['Privacy Act 1988', 'Australian AI Ethics Framework'],
  'Middle East': ['UAE AI Strategy', 'Saudi Arabia PDPL'],
  'Asia Pacific': ['APAC data protection frameworks', 'Singapore PDPA'],
  'Other': ['Local data protection laws', 'Consult local legal counsel']
};

function sanitise(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, '').slice(0, maxLen).trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { deptToken, answers } = req.body;

  if (!deptToken || typeof deptToken !== 'string' || deptToken.length > 50) {
    return res.status(400).json({ error: 'Invalid department token' });
  }

  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return res.status(400).json({ error: 'Invalid answers format' });
  }

  try {
    // Look up department token
    const deptData = await redis.get(`clearai:dept:${deptToken}`);
    if (!deptData) {
      return res.status(404).json({ error: 'Assessment link not found or expired.' });
    }

    const { sessionId, dept } = typeof deptData === 'string' ? JSON.parse(deptData) : deptData;

    // Get session
    const sessionData = await redis.get(`clearai:session:${sessionId}`);
    if (!sessionData) {
      return res.status(404).json({ error: 'Assessment session not found or expired.' });
    }

    const session = typeof sessionData === 'string' ? JSON.parse(sessionData) : sessionData;

    // Check if already submitted
    if (session.responses[dept]) {
      return res.status(409).json({ error: 'This department has already submitted their responses.' });
    }

    // Validate and sanitise answers
    const sanitisedAnswers = {
      locations: Array.isArray(answers.locations)
        ? answers.locations.filter(l => ALLOWED_COUNTRIES.includes(l)).slice(0, 8)
        : [],
      aiTools: Array.isArray(answers.aiTools)
        ? answers.aiTools.map(t => sanitise(t, 100)).filter(Boolean).slice(0, 30)
        : [],
      aiUses: Array.isArray(answers.aiUses)
        ? answers.aiUses.map(u => sanitise(u, 100)).filter(Boolean).slice(0, 20)
        : [],
      governance: typeof answers.governance === 'object' && !Array.isArray(answers.governance)
        ? Object.fromEntries(
            Object.entries(answers.governance)
              .filter(([k, v]) => typeof k === 'string' && ['yes', 'no', 'ns'].includes(v))
              .slice(0, 10)
          )
        : {},
      additionalNotes: sanitise(answers.additionalNotes || '', 500)
    };

    // Build regulatory profile for this department based on locations
    const allLocations = [...new Set([session.primaryCountry, ...sanitisedAnswers.locations])];
    const regulations = allLocations.flatMap(loc => DEPT_COUNTRY_REGULATIONS[loc] || []);
    sanitisedAnswers.regulatoryProfile = [...new Set(regulations)];
    sanitisedAnswers.locations = allLocations;
    sanitisedAnswers.submittedAt = new Date().toISOString();

    // Update session with this department's response
    session.responses[dept] = sanitisedAnswers;

    // Check if all departments have responded
    const totalDepts = session.departments.length;
    const respondedDepts = Object.keys(session.responses).length;
    session.status = respondedDepts >= totalDepts ? 'complete' : 'pending';

    const remainingTtl = (session.expiryDays || 14) * 24 * 60 * 60;
    await redis.set(`clearai:session:${sessionId}`, JSON.stringify(session), { ex: remainingTtl });

    return res.status(200).json({
      success: true,
      dept,
      respondedCount: respondedDepts,
      totalCount: totalDepts,
      allComplete: session.status === 'complete'
    });

  } catch (err) {
    console.error('Submit error:', err.message);
    return res.status(500).json({ error: 'Failed to submit responses. Please try again.' });
  }
}
