import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 2;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function buildDeptSummary(dept, response, primaryCountry) {
  const govGaps = Object.entries(response.governance || {})
    .filter(([, v]) => v === 'no' || v === 'ns')
    .map(([k]) => k);

  return `
DEPARTMENT: ${dept}
Locations/jurisdictions: ${response.locations?.join(', ') || primaryCountry}
Applicable regulations: ${response.regulatoryProfile?.join(', ') || 'UK ICO'}
AI tools in use: ${response.aiTools?.length > 0 ? response.aiTools.join(', ') : 'None declared'}
AI use cases: ${response.aiUses?.length > 0 ? response.aiUses.join(', ') : 'None declared'}
Governance gaps: ${govGaps.length > 0 ? govGaps.join(', ') : 'None identified'}
Additional notes: ${response.additionalNotes || 'None'}
Submitted: ${response.submittedAt || 'Unknown'}`;
}

function calculateDeptScore(response, primaryCountry) {
  let score = 0;

  // Regulatory exposure
  const locations = response.locations || [primaryCountry];
  if (locations.includes('EU member state')) score += 12;
  if (locations.includes('United States')) score += 8;
  if (locations.includes('Canada')) score += 5;
  if (locations.includes('Australia')) score += 5;
  if (locations.length > 2) score += 5;
  score = Math.min(score, 25);

  // Shadow AI
  const toolCount = response.aiTools?.length || 0;
  score += Math.min(toolCount * 2, 15);

  // Governance gaps
  const govAnswers = Object.values(response.governance || {});
  const noCount = govAnswers.filter(v => v === 'no').length;
  const nsCount = govAnswers.filter(v => v === 'ns').length;
  score += Math.min((noCount * 4) + (nsCount * 2), 20);

  return Math.min(score, 60);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
  }

  const { token } = req.body;

  if (!token || typeof token !== 'string' || token.length > 50) {
    return res.status(400).json({ error: 'Invalid results token' });
  }

  try {
    // Look up session
    const sessionId = await redis.get(`clearai:results:${token}`);
    if (!sessionId) {
      return res.status(404).json({ error: 'Assessment not found or expired.' });
    }

    const sessionData = await redis.get(`clearai:session:${sessionId}`);
    if (!sessionData) {
      return res.status(404).json({ error: 'Assessment session not found or expired.' });
    }

    const session = typeof sessionData === 'string' ? JSON.parse(sessionData) : sessionData;

    if (Object.keys(session.responses).length === 0) {
      return res.status(400).json({ error: 'No department responses received yet.' });
    }

    // Calculate per-department scores
    const deptScores = {};
    let totalScore = 0;

    for (const [dept, response] of Object.entries(session.responses)) {
      const score = calculateDeptScore(response, session.primaryCountry);
      deptScores[dept] = score;
      totalScore += score;
    }

    const avgScore = Math.round(totalScore / Object.keys(session.responses).length);

    // Build department summaries for prompt
    const deptSummaries = Object.entries(session.responses)
      .map(([dept, response]) => buildDeptSummary(dept, response, session.primaryCountry))
      .join('\n\n---\n');

    // Collect all unique regulations across all departments
    const allRegulations = [...new Set(
      Object.values(session.responses)
        .flatMap(r => r.regulatoryProfile || [])
    )];

    // Collect all tools
    const allTools = [...new Set(
      Object.values(session.responses)
        .flatMap(r => r.aiTools || [])
    )];

    const prompt = `You are a senior AI governance consultant generating a comprehensive organisational AI risk report.

ORGANISATION PROFILE:
Company: ${session.companyName}
Industry: ${session.industry}
Size: ${session.employees} employees
Primary location: ${session.primaryCountry}
Assessment date: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
Departments assessed: ${session.departments.join(', ')}
Departments responded: ${Object.keys(session.responses).join(', ')}

OVERALL RISK SCORE: ${avgScore}/100

DEPARTMENT SCORES:
${Object.entries(deptScores).map(([d, s]) => `${d}: ${s}/60`).join('\n')}

ALL APPLICABLE REGULATIONS (across all departments):
${allRegulations.join(', ') || 'UK ICO AI principles'}

ALL AI TOOLS IN USE (across all departments):
${allTools.join(', ') || 'None declared'}

DEPARTMENT-BY-DEPARTMENT FINDINGS:
${deptSummaries}

Generate a comprehensive organisational AI risk report as a JSON object with exactly these keys:
{
  "executiveSummary": "Executive summary for board/leadership — overall risk picture, key findings, urgent actions",
  "departmentFindings": "Department-by-department breakdown — each department's risk profile, tools, regulations, and specific gaps",
  "regulatoryObligations": "Full regulatory obligations mapped to each department based on their specific geographic exposure",
  "remediationPlan": "Prioritised 30/60/90 day action plan broken down by department and urgency",
  "toolInventory": "Complete organisational AI tool inventory across all departments with risk classifications",
  "governanceFramework": "Recommended governance structure for the whole organisation including AI ownership, policies, and oversight"
}

CRITICAL REQUIREMENTS:
- Reference the actual company name throughout
- Each department section must reflect their specific geographic exposure and regulations — do not apply EU AI Act to a department with no EU exposure
- The remediation plan must assign specific actions to specific departments
- The tool inventory must attribute tools to the departments that use them
- Language must be board-ready — clear, professional, specific
- No placeholders, no truncation, no "insert here" text
- Return ONLY valid JSON. No markdown. No backticks. No preamble.`;

    // Generate report
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;
    const clean = raw.replace(/```json|```/g, '').trim();
    let report;

    try {
      report = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'Report generation failed — please try again.' });
    }

    // Review pass
    const reviewPrompt = `You are a senior AI governance auditor reviewing an organisational AI risk report.

Review this report for ${session.companyName} and check:
1. All department names referenced correctly
2. Regulations match each department's actual geographic exposure
3. No placeholder text or incomplete sections
4. 30/60/90 day plan has specific, actionable tasks assigned to specific departments
5. Tool inventory attributes tools to correct departments
6. Professional board-ready language throughout
7. No contradictions between sections

REPORT TO REVIEW:
${JSON.stringify(report).slice(0, 8000)}

Return a JSON object with these keys:
{
  "passed": true/false,
  "executiveSummary": "corrected or confirmed text",
  "departmentFindings": "corrected or confirmed text",
  "regulatoryObligations": "corrected or confirmed text",
  "remediationPlan": "corrected or confirmed text",
  "toolInventory": "corrected or confirmed text",
  "governanceFramework": "corrected or confirmed text",
  "issues_found": []
}

Return ONLY valid JSON. No markdown. No backticks.`;

    let reviewed;
    try {
      const reviewMsg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: reviewPrompt }]
      });
      const reviewRaw = reviewMsg.content[0].text;
      reviewed = JSON.parse(reviewRaw.replace(/```json|```/g, '').trim());
    } catch {
      reviewed = { ...report, passed: false, issues_found: ['Review pass failed — original returned'] };
    }

    const finalReport = {
      executiveSummary: reviewed.executiveSummary || report.executiveSummary,
      departmentFindings: reviewed.departmentFindings || report.departmentFindings,
      regulatoryObligations: reviewed.regulatoryObligations || report.regulatoryObligations,
      remediationPlan: reviewed.remediationPlan || report.remediationPlan,
      toolInventory: reviewed.toolInventory || report.toolInventory,
      governanceFramework: reviewed.governanceFramework || report.governanceFramework,
    };

    console.log('Team report generated:', {
      company: session.companyName,
      departments: Object.keys(session.responses),
      score: avgScore,
      reviewed: reviewed.passed
    });

    return res.status(200).json({
      report: finalReport,
      meta: {
        companyName: session.companyName,
        industry: session.industry,
        employees: session.employees,
        primaryCountry: session.primaryCountry,
        departmentsAssessed: Object.keys(session.responses),
        overallScore: avgScore,
        departmentScores: deptScores,
        allRegulations,
        allTools,
        reviewed: true,
        passed: reviewed.passed === true
      }
    });

  } catch (err) {
    console.error('Team generate error:', err.message);

    if (err.status === 429) {
      return res.status(503).json({ error: 'AI service temporarily unavailable — please try again shortly.' });
    }

    return res.status(500).json({ error: 'Failed to generate report. Please try again.' });
  }
}
