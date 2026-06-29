import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ═══════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 3; // max 3 requests per IP per minute

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.start > RATE_LIMIT_WINDOW * 5) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════
// INPUT VALIDATION
// ═══════════════════════════════════════════════
const ALLOWED_INDUSTRIES = [
  'Professional services', 'Retail and e-commerce', 'Healthcare and social care',
  'Finance and insurance', 'Education and training', 'Construction and property',
  'Technology and software', 'Hospitality and leisure', 'Manufacturing', 'Other'
];

const ALLOWED_EMPLOYEES = ['1–10', '11–50', '51–250', '250+'];

const ALLOWED_JURISDICTIONS = [
  'eu-customers', 'personal-data', 'us-customers', 'financial-services',
  'healthcare', 'eu-suppliers', 'uk-only'
];

const ALLOWED_GOVERNANCE_IDS = [
  'policy', 'training', 'register', 'privacy', 'owner', 'outputs'
];

const ALLOWED_GOVERNANCE_VALS = ['yes', 'no', 'ns'];

function validateInput(body) {
  const errors = [];

  if (!body.companyName || typeof body.companyName !== 'string' || body.companyName.trim().length === 0) {
    errors.push('Company name is required');
  }

  if (!ALLOWED_INDUSTRIES.includes(body.industry)) {
    errors.push('Invalid industry');
  }

  if (!ALLOWED_EMPLOYEES.includes(body.employees)) {
    errors.push('Invalid employee count');
  }

  if (!Array.isArray(body.jurisdictions)) {
    errors.push('Jurisdictions must be an array');
  } else {
    const invalidJ = body.jurisdictions.filter(j => !ALLOWED_JURISDICTIONS.includes(j));
    if (invalidJ.length > 0) errors.push('Invalid jurisdiction values');
  }

  if (!Array.isArray(body.aiTools)) {
    errors.push('AI tools must be an array');
  }

  if (!Array.isArray(body.aiUses)) {
    errors.push('AI uses must be an array');
  }

  if (typeof body.governance !== 'object' || Array.isArray(body.governance)) {
    errors.push('Governance must be an object');
  } else {
    for (const [key, val] of Object.entries(body.governance)) {
      if (!ALLOWED_GOVERNANCE_IDS.includes(key)) errors.push('Invalid governance key: ' + key);
      if (!ALLOWED_GOVERNANCE_VALS.includes(val)) errors.push('Invalid governance value: ' + val);
    }
  }

  return errors;
}

function sanitiseString(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, '').slice(0, maxLen).trim();
}

// ═══════════════════════════════════════════════
// DOCUMENT GENERATION
// ═══════════════════════════════════════════════
async function generateDocuments(payload) {
  const {
    companyName, industry, employees,
    jurisdictions, aiTools, aiUses, governance
  } = payload;

  const jurisdictionLabels = {
    'eu-customers': 'EU customers/clients (EU AI Act applies)',
    'personal-data': 'Personal data handling (UK GDPR/ICO applies)',
    'us-customers': 'US customers (US state AI laws apply)',
    'financial-services': 'Financial services (FCA Consumer Duty applies)',
    'healthcare': 'Healthcare operations (MHRA AI framework applies)',
    'eu-suppliers': 'EU suppliers/partners (EU AI Act applies)',
    'uk-only': 'UK domestic only (UK ICO AI principles apply)'
  };

  const govLabels = {
    policy: 'Written AI acceptable use policy',
    training: 'Documented staff AI safety training',
    register: 'Approved AI tool register',
    privacy: 'Data privacy impact assessment per tool',
    owner: 'Named AI governance owner',
    outputs: 'AI output review process'
  };

  const govStatus = Object.entries(governance)
    .map(([k, v]) => `${govLabels[k] || k}: ${v === 'yes' ? 'IN PLACE' : v === 'no' ? 'ABSENT' : 'UNCERTAIN'}`)
    .join('\n');

  const applicableRegs = jurisdictions.map(j => jurisdictionLabels[j] || j).join('\n');

  const prompt = `You are a specialist AI governance consultant generating a professional compliance pack for a business client.

COMPANY PROFILE:
- Company name: ${sanitiseString(companyName)}
- Industry: ${sanitiseString(industry)}
- Size: ${sanitiseString(employees)} employees
- Assessment date: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}

REGULATORY EXPOSURE:
${applicableRegs || 'UK domestic only — UK ICO AI principles apply'}

AI TOOLS IN USE:
${aiTools.length > 0 ? aiTools.map(t => '- ' + sanitiseString(t, 100)).join('\n') : '- None declared (likely under-reported)'}

AI USE CASES:
${aiUses.length > 0 ? aiUses.map(u => '- ' + sanitiseString(u, 100)).join('\n') : '- None declared'}

CURRENT GOVERNANCE STATUS:
${govStatus}

Generate exactly three professional documents as a JSON object with these keys: inventory, policy, report.

DOCUMENT 1 — "inventory" (AI Tool Inventory):
- Title: AI Tool Inventory — [Company Name]
- Date of assessment
- Executive summary of tools found
- For each tool identified: name, category, risk classification (Unacceptable/High/Limited/Minimal per EU AI Act tiers where applicable), current governance status (managed/unmanaged), and recommended action
- A shadow AI discovery checklist for tools not yet identified
- Sign-off section with date and responsible person field
- Footer: "Generated by ClearAI. This document is a starting point only and requires professional review before implementation."

DOCUMENT 2 — "policy" (AI Acceptable Use Policy):
- Title: AI Acceptable Use Policy — [Company Name]
- Version 1.0, date
- Scope and purpose
- Definitions (AI tool, shadow AI, approved tool, etc.)
- Approved AI tools list (from inventory above)
- Prohibited uses (specific, practical, not vague)
- Staff obligations (specific actions required)
- Data handling rules when using AI
- Shadow AI prohibition and reporting process
- Human oversight requirements
- Consequences of non-compliance
- Review schedule
- Signature block: [Name], [Job Title], [Date], [Signature]
- Footer: "Generated by ClearAI. This policy is a starting point only and requires review by a qualified solicitor before adoption."

DOCUMENT 3 — "report" (Risk and Remediation Report):
- Title: AI Risk and Remediation Report — [Company Name]
- Executive summary with risk score context
- Regulatory obligations specific to this company's profile
- Risk findings ranked by urgency (Critical/High/Medium/Low)
- For each finding: description, regulatory basis, current status, recommended action, priority
- 30/60/90 day action plan with specific tasks
- What good looks like when complete
- Footer: "Generated by ClearAI. This report is a starting point only and requires professional review before relying on it in a regulatory context."

CRITICAL REQUIREMENTS:
- Every document must reference the actual company name throughout
- Every regulatory reference must match the company's actual jurisdiction profile
- Documents must be complete — no placeholders, no "insert here", no truncation
- Language must be professional, clear, and appropriate for a business document
- The policy must be immediately usable with only solicitor review required
- Return ONLY valid JSON. No markdown. No backticks. No preamble. No explanation.`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6000,
    messages: [{ role: "user", content: prompt }]
  });

  const raw = message.content[0].text;
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ═══════════════════════════════════════════════
// DOCUMENT QUALITY REVIEW
// ═══════════════════════════════════════════════
async function reviewDocuments(documents, payload) {
  const { companyName, industry, jurisdictions, aiTools, governance } = payload;

  const noGovCount = Object.values(governance).filter(v => v === 'no').length;
  const hasEU = jurisdictions.includes('eu-customers') || jurisdictions.includes('eu-suppliers');
  const hasUKGDPR = jurisdictions.includes('personal-data');

  const reviewPrompt = `You are a senior AI governance auditor reviewing three compliance documents before they are delivered to a client.

CLIENT CONTEXT:
- Company: ${sanitiseString(companyName)}
- Industry: ${sanitiseString(industry)}
- AI tools declared: ${aiTools.length}
- EU AI Act in scope: ${hasEU ? 'YES' : 'NO'}
- UK GDPR in scope: ${hasUKGDPR ? 'YES' : 'NO'}
- Governance gaps: ${noGovCount} of 6 requirements absent

DOCUMENTS TO REVIEW:

=== INVENTORY ===
${documents.inventory.slice(0, 3000)}

=== POLICY ===
${documents.policy.slice(0, 3000)}

=== REPORT ===
${documents.report.slice(0, 3000)}

Review these three documents and return a JSON object with this exact structure:
{
  "passed": true/false,
  "inventory": "corrected or confirmed inventory text — full document",
  "policy": "corrected or confirmed policy text — full document",
  "report": "corrected or confirmed report text — full document",
  "issues_found": ["list of issues found and corrected, or empty array if none"]
}

Check for and fix ALL of the following:
1. Company name referenced correctly throughout all three documents
2. Regulations mentioned match the client profile (do not add EU AI Act if EU not in scope, etc.)
3. No placeholder text, "TBC", "insert here", or incomplete sections
4. Policy has a complete signature block
5. Report has a 30/60/90 day action plan
6. Inventory lists all declared tools with risk classifications
7. No contradictions between the three documents
8. Professional language throughout — no casual tone, no errors
9. All footers present with disclaimer text
10. Documents are complete and not truncated

If a document passes all checks, return it unchanged.
If a document has issues, correct them and return the corrected version.
Set "passed" to true only if all three documents required no corrections.

Return ONLY valid JSON. No markdown. No backticks. No preamble.`;

  const reviewMessage = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6000,
    messages: [{ role: "user", content: reviewPrompt }]
  });

  const raw = reviewMessage.content[0].text;
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ═══════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════
export default async function handler(req, res) {

  // Method check
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.headers['x-real-ip'] ||
             req.socket?.remoteAddress ||
             'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute before trying again.'
    });
  }

  // Body size check
  const bodyStr = JSON.stringify(req.body);
  if (bodyStr.length > 10000) {
    return res.status(413).json({ error: 'Request too large' });
  }

  // Input validation
  const validationErrors = validateInput(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'Invalid input',
      details: validationErrors
    });
  }

  // Sanitise payload
  const payload = {
    companyName: sanitiseString(req.body.companyName, 200),
    industry: req.body.industry,
    employees: req.body.employees,
    jurisdictions: req.body.jurisdictions.filter(j => ALLOWED_JURISDICTIONS.includes(j)).slice(0, 10),
    aiTools: req.body.aiTools.map(t => sanitiseString(t, 100)).filter(Boolean).slice(0, 50),
    aiUses: req.body.aiUses.map(u => sanitiseString(u, 100)).filter(Boolean).slice(0, 50),
    governance: Object.fromEntries(
      Object.entries(req.body.governance)
        .filter(([k, v]) => ALLOWED_GOVERNANCE_IDS.includes(k) && ALLOWED_GOVERNANCE_VALS.includes(v))
    )
  };

  try {

    // PASS 1 — Generate documents
    let documents;
    try {
      documents = await generateDocuments(payload);
    } catch (parseErr) {
      console.error('Generation parse error:', parseErr);
      return res.status(500).json({
        error: 'Document generation failed — please try again.'
      });
    }

    // Validate generation output structure
    if (!documents || typeof documents !== 'object' ||
        typeof documents.inventory !== 'string' ||
        typeof documents.policy !== 'string' ||
        typeof documents.report !== 'string') {
      return res.status(500).json({
        error: 'Document generation returned an unexpected format — please try again.'
      });
    }

    // Minimum length sanity check
    if (documents.inventory.length < 100 ||
        documents.policy.length < 100 ||
        documents.report.length < 100) {
      return res.status(500).json({
        error: 'Documents appear incomplete — please try again.'
      });
    }

    // PASS 2 — Review and correct documents
    let reviewed;
    try {
      reviewed = await reviewDocuments(documents, payload);
    } catch (reviewErr) {
      console.error('Review parse error:', reviewErr);
      // If review fails, still return the original documents rather than failing entirely
      reviewed = {
        passed: false,
        inventory: documents.inventory,
        policy: documents.policy,
        report: documents.report,
        issues_found: ['Review pass could not complete — original documents returned']
      };
    }

    // Use reviewed versions if available and valid
    const finalDocuments = {
      inventory: (typeof reviewed.inventory === 'string' && reviewed.inventory.length > 100)
        ? reviewed.inventory.slice(0, 20000)
        : documents.inventory.slice(0, 20000),
      policy: (typeof reviewed.policy === 'string' && reviewed.policy.length > 100)
        ? reviewed.policy.slice(0, 20000)
        : documents.policy.slice(0, 20000),
      report: (typeof reviewed.report === 'string' && reviewed.report.length > 100)
        ? reviewed.report.slice(0, 20000)
        : documents.report.slice(0, 20000)
    };

    // Log review outcome (server side only, never sent to client)
    console.log('Document review:', {
      company: payload.companyName,
      passed: reviewed.passed,
      issues: reviewed.issues_found || []
    });

    return res.status(200).json({
      documents: finalDocuments,
      meta: {
        reviewed: true,
        passed: reviewed.passed === true
      }
    });

  } catch (error) {
    console.error('Handler error:', error.message);

    // Don't leak internal error details to client
    if (error.status === 429) {
      return res.status(503).json({
        error: 'AI service temporarily unavailable — please try again in a moment.'
      });
    }

    if (error.name === 'AbortError') {
      return res.status(504).json({
        error: 'Request timed out — please try again.'
      });
    }

    return res.status(500).json({
      error: 'Something went wrong generating your documents. Please try again.'
    });
  }
}
