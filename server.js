import express from "express";
import OpenAI from "openai";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config(); // Only needed locally

const app = express();
app.use(express.json());
app.use(cors());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

app.post("/api/appeal-check", async (req, res) => {
  const { fineDetails, appealReason } = req.body;
  const prompt = `
    Evaluate this parking fine appeal.
    Fine details: ${JSON.stringify(fineDetails, null, 2)}
    Appeal reason: ${JSON.stringify(appealReason, null, 2)}
    
    Respond strictly in JSON with:
    {
      "appeal_strength": "strong" | "medium" | "weak",
      "confidence_score": number (0-100),
      "reasoning_summary": string (max 2 sentences)
    }
  `;
  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      text: { format: { type: "json" } },
      temperature: 0.3,
    });
    const result = JSON.parse(response.output_text);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error processing appeal check" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
