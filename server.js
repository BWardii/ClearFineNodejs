// server.js

const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload'); // for image uploads
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload()); // enable file upload for /extract-fine

// ------------------ Health check ------------------
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Appeal AI Backend is running' });
});

// ------------------ Appeal check endpoint ------------------
app.post('/api/appeal-check', async (req, res) => {
  try {
    const { fineDetails, appealReason } = req.body;
    
    if (!fineDetails || !appealReason) {
      return res.status(400).json({ 
        error: 'Missing required fields: fineDetails and appealReason are required' 
      });
    }

    const prompt = createAppealPrompt(fineDetails, appealReason);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert parking fine appeals advisor. Analyze the provided fine details and appeal reason, then determine the likelihood of a successful appeal. Respond with a JSON object containing: appeal_strength (strong/medium/weak), confidence_score (0-100), and reasoning_summary (max 2 sentences)."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    const response = completion.choices[0].message.content;

    let appealAnalysis;
    try {
      appealAnalysis = JSON.parse(response);
    } catch (parseError) {
      appealAnalysis = {
        appeal_strength: "medium",
        confidence_score: 50,
        reasoning_summary: "Unable to analyze the appeal details properly. Please review your appeal reason and try again."
      };
    }

    if (!appealAnalysis.appeal_strength || !appealAnalysis.confidence_score || !appealAnalysis.reasoning_summary) {
      throw new Error('Invalid response structure from AI');
    }

    res.json(appealAnalysis);

  } catch (error) {
    console.error('Error processing appeal check:', error);
    res.status(500).json({ 
      error: 'Failed to analyze appeal chances',
      details: error.message 
    });
  }
});

// Helper function to create the prompt
function createAppealPrompt(fineDetails, appealReason) {
  return `
Please analyze this parking fine appeal case:

FINE DETAILS:
- Contravention Code: ${fineDetails.contravention_code}
- Location: ${fineDetails.location}
- Date: ${fineDetails.date}
- Amount: ${fineDetails.amount}
- Reason: ${fineDetails.reason}

APPEAL REASON:
- Category: ${appealReason.category}
- Selected Reason: ${appealReason.selected_reason}
- Additional Details: ${appealReason.user_note || 'None provided'}

Please analyze the strength of this appeal and provide your assessment in the following JSON format:
{
  "appeal_strength": "strong|medium|weak",
  "confidence_score": 0-100,
  "reasoning_summary": "Brief explanation of your assessment (max 2 sentences)"
}

Consider factors such as:
- Validity of the appeal reason
- Strength of evidence that could be provided
- Common success rates for similar appeals
- Legal precedents and council policies
- Whether the reason falls under accepted appeal categories

Respond with only the JSON object, no additional text.
  `.trim();
}

// ------------------ Parking fine image extraction endpoint ------------------
app.post("/api/extract-fine", async (req, res) => {
  try {
    const file = req.files?.image;
    if (!file) return res.status(400).json({ error: "No image uploaded" });

    const base64 = file.data.toString("base64");

    const instruction = `
You are a data extraction agent.
Extract the following fields from the parking fine letter in the image:

- fineAmount (include currency)
- infractionDate (YYYY-MM-DD)
- locationAddress
- carRegistration
- fineReferenceNumber

Return ONLY a valid JSON object. If any field is missing, use an empty string.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: `data:${file.mimetype};base64,${base64}` },
          ],
        },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const result = completion.choices[0].message.content;
    res.json(JSON.parse(result));

  } catch (error) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: "Failed to extract fine data" });
  }
});

// ------------------ Error handling middleware ------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ------------------ Start server ------------------
app.listen(port, () => {
  console.log(`🚀 Appeal AI Backend running on port ${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
  console.log(`🤖 Appeal check: http://localhost:${port}/api/appeal-check`);
  console.log(`📷 Extract fine: http://localhost:${port}/api/extract-fine`);
});

module.exports = app;
