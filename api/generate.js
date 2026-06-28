import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { companyName, industry, employees, jurisdictions, aiTools, aiUses, governance } = req.body;

  try {
    const prompt = `You are an AI governance expert generating a compliance pack for an SMB.

Company details:
- Name: ${companyName}
- Industry: ${industry}
- Employees: ${employees}
- Jurisdictions/regulations that apply: ${jurisdictions.join(", ")}
- AI tools in use: ${aiTools.length > 0 ? aiTools.join(", ") : "None declared"}
- AI use cases: ${aiUses.length > 0 ? aiUses.join(", ") : "None declared"}
- Governance status: ${JSON.stringify(governance)}

Generate three documents in JSON format with exactly these keys:
{
  "inventory": "Full AI Tool Inventory document as plain text",
  "policy": "Full AI Acceptable Use Policy document as plain text",
  "report": "Full Risk and Remediation Report as plain text"
}

Each document should be professional, specific to this company, reference the actual tools and regulations that apply, and be ready to use. The policy should be signable. The report should prioritise actions by urgency. Return only valid JSON, no markdown, no backticks.`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const responseText = message.content[0].text;
    
    let documents;
    try {
      documents = JSON.parse(responseText);
    } catch {
      documents = {
        inventory: "Document generation failed — please try again.",
        policy: "Document generation failed — please try again.",
        report: "Document generation failed — please try again.",
      };
    }

    return res.status(200).json({ documents });

  } catch (error) {
    console.error("Claude API error:", error);
    return res.status(500).json({ 
      error: "Failed to generate documents",
      details: error.message 
    });
  }
}
