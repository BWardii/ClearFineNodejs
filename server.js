import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(bodyParser.json());

//  OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

//  Endpoint 1: Appeal Strength Checker
app.post("/api/appeal-check", async (req, res) => {
  try {
    const { fineDetails, appealReason, personalReason } = req.body;

    if (!fineDetails || !appealReason) {
      return res.status(400).json({ error: "Missing fine details or appeal reason" });
    }

    const prompt = `
You are an AI assistant that evaluates parking fine appeals in the UK.
You will classify the appeal into one of three categories: "strong", "medium", or "weak" grounds for appeal.
Base your judgement on the legality of the reason, fairness, and common parking regulations.

Fine details:
${JSON.stringify(fineDetails, null, 2)}

Appeal reason:
${appealReason}

Personal reason:
${personalReason || "None provided"}

Respond strictly in JSON format:
{
  "appeal_strength": "strong | medium | weak",
  "confidence_score": number (0-100),
  "reasoning_summary": "short explanation"
}
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      text: { format: { type: "json_object" } },
      temperature: 0.3,
    });

    const jsonOutput = JSON.parse(response.output[0].content[0].text);

    res.json(jsonOutput);
  } catch (error) {
    console.error("Error processing appeal check:", error);
    res.status(500).json({ error: "Error processing appeal check" });
  }
});

//  Endpoint 2: Generate Professional Appeal Letter
app.post("/api/write-appeal", async (req, res) => {
  try {
    const { fineDetails, appealReason, personalReason } = req.body;

    if (!fineDetails || !appealReason) {
      return res.status(400).json({ error: "Missing fine details or appeal reason" });
    }

    const prompt = `
You are a legal writing assistant.
Write a concise, polite, and professional appeal letter for a parking fine based on these details:

Fine Details:
${JSON.stringify(fineDetails, null, 2)}

Reason for Appeal:
${appealReason}

Personal Reason (if any):
${personalReason || "None provided"}

Guidelines:
- Tone: respectful, factual, formal
- Avoid emotional or unnecessary language
- Keep it under 200 words
- End with "Yours faithfully,"
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      text: { format: { type: "text" } },
      temperature: 0.5,
    });

    const aiText = response.output[0].content[0].text.trim();

    res.json({
      appeal_letter: aiText,
    });
  } catch (error) {
    console.error("Error generating appeal letter:", error);
    res.status(500).json({ error: "Error generating appeal letter" });
  }
});

// Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
