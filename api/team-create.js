import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ALLOWED_INDUSTRIES = [
  'Professional services', 'Retail and e-commerce', 'Healthcare and social care',
  'Finance and insurance', 'Education and training', 'Construction and property',
  'Technology and software', 'Hospitality and leisure', 'Manufacturing', 'Other'
];

const ALLOWED_EMPLOYEES = ['1–10', '11–50', '51–250', '250+'];

const ALLOWED_DEPARTMENTS = ['IT', 'HR', 'Finance', 'Marketing', 'Operations', 'Legal'];

const ALLOWED_COUNTRIES = ['UK', 'EU member state', 'United States', 'Canada', 'Australia', 'Middle East', 'Asia Pacific', 'Other'];

const ALLOWED_EXPIRY_DAYS = [7, 14, 30];
const DEFAULT_EXPIRY_DAYS = 14;

function generateId(length = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function sanitise(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, '').slice(0, maxLen).trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { companyName, industry, employees, primaryCountry, departments, expiryDays } = req.body;

  // Validate
  const errors = [];
  if (!companyName || typeof companyName !== 'string' || companyName.trim().length === 0) errors.push('Company name required');
  if (!ALLOWED_INDUSTRIES.includes(industry)) errors.push('Invalid industry');
  if (!ALLOWED_EMPLOYEES.includes(employees)) errors.push('Invalid employee count');
  if (!ALLOWED_COUNTRIES.includes(primaryCountry)) errors.push('Invalid primary country');
  if (!Array.isArray(departments) || departments.length === 0) errors.push('At least one department required');
  if (departments && departments.some(d => !ALLOWED_DEPARTMENTS.includes(d))) errors.push('Invalid department');
  const resolvedExpiry = ALLOWED_EXPIRY_DAYS.includes(Number(expiryDays)) ? Number(expiryDays) : DEFAULT_EXPIRY_DAYS;
  const sessionTtl = resolvedExpiry * 24 * 60 * 60;

  if (departments && departments.length > 6) errors.push('Maximum 6 departments');

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid input', details: errors });
  }

  // Generate session and department tokens
  const sessionId = generateId(16);
  const resultsToken = generateId(20);

  const departmentLinks = {};
  const departmentTokens = {};

  departments.forEach(dept => {
    const token = generateId(16);
    departmentTokens[dept] = token;
    departmentLinks[dept] = token;
  });

  // Store session in Redis
  const session = {
    sessionId,
    resultsToken,
    companyName: sanitise(companyName),
    industry,
    employees,
    primaryCountry,
    departments,
    departmentTokens,
    responses: {},
    expiryDays: resolvedExpiry,
    createdAt: new Date().toISOString(),
    status: 'pending'
  };

  try {
    await redis.set(`clearai:session:${sessionId}`, JSON.stringify(session), { ex: sessionTtl });

    // Also index by results token for lookup
    await redis.set(`clearai:results:${resultsToken}`, sessionId, { ex: sessionTtl });

    // Index each department token
    for (const [dept, token] of Object.entries(departmentTokens)) {
      await redis.set(`clearai:dept:${token}`, JSON.stringify({ sessionId, dept }), { ex: sessionTtl });
    }

    return res.status(200).json({
      sessionId,
      resultsToken,
      departmentLinks,
      expiresIn: resolvedExpiry + ' days'
    });

  } catch (err) {
    console.error('Redis error:', err.message);
    return res.status(500).json({ error: 'Failed to create assessment session. Please try again.' });
  }
}
