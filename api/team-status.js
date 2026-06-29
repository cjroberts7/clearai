import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.query;

  if (!token || typeof token !== 'string' || token.length > 50) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  try {
    // Look up session by results token
    const sessionId = await redis.get(`clearai:results:${token}`);
    if (!sessionId) {
      return res.status(404).json({ error: 'Assessment not found or expired.' });
    }

    const sessionData = await redis.get(`clearai:session:${sessionId}`);
    if (!sessionData) {
      return res.status(404).json({ error: 'Assessment session not found or expired.' });
    }

    const session = typeof sessionData === 'string' ? JSON.parse(sessionData) : sessionData;

    const respondedDepts = Object.keys(session.responses);
    const pendingDepts = session.departments.filter(d => !respondedDepts.includes(d));

    return res.status(200).json({
      companyName: session.companyName,
      totalDepartments: session.departments.length,
      respondedDepartments: respondedDepts,
      pendingDepartments: pendingDepts,
      status: session.status,
      allComplete: session.status === 'complete',
      createdAt: session.createdAt,
      expiryDays: session.expiryDays || 14,
      expiresAt: new Date(new Date(session.createdAt).getTime() + ((session.expiryDays || 14) * 24 * 60 * 60 * 1000)).toISOString()
    });

  } catch (err) {
    console.error('Status error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve status. Please try again.' });
  }
}
