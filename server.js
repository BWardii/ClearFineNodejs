const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
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
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 },
  useTempFiles: true,
  tempFileDir: '/tmp/'
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Appeal AI Backend is running' });
});

// Extract fine data from image using OpenAI Vision
app.post('/api/extract-fine', async (req, res) => {
  try {
    if (!req.files || !req.files.image) {
      return res.status(400).json({ 
        error: 'Missing required file: image file is required' 
      });
    }

    const imageFile = req.files.image;
    const imageBuffer = imageFile.data;
    const base64Image = imageBuffer.toString('base64');
    const imageMediaType = imageFile.mimetype || 'image/jpeg';

    // Call OpenAI Vision API to extract parking fine data
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are an expert at extracting information from parking fine notices. 
              
Please analyze this parking fine image and extract the following information:
1. Fine Amount (numerical value, e.g., 65.00)
2. Infraction Date (date the violation occurred, format: YYYY-MM-DD or as shown on fine)
3. Location Address (where the violation occurred)
4. Car Registration (vehicle registration plate number)
5. Fine Reference Number (PCN, reference number, ticket number, or similar identifier)

Return the data as a JSON object with these exact keys:
- fineAmount (string, e.g., "65.00")
- infractionDate (string, date format)
- locationAddress (string)
- carRegistration (string)
- fineReferenceNumber (string)

If any field cannot be found, use null for that field.
Return ONLY valid JSON, no additional text.`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${imageMediaType};base64,${base64Image}`,
                detail: "auto"
              }
            }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    const extractedText = response.choices[0].message.content;

    // Parse the JSON response from OpenAI
    let extractedData;
    try {
      extractedData = JSON.parse(extractedText);
    } catch (parseError) {
      return res.status(400).json({
        error: 'Failed to parse extraction data',
        details: 'Could not extract valid data from the image'
      });
    }

    // Return structured response that iOS app expects
    res.json({
      success: true,
      data: {
        fineAmount: extractedData.fineAmount || "",
        infractionDate: extractedData.infractionDate || "",
        locationAddress: extractedData.locationAddress || "",
        carRegistration: extractedData.carRegistration || "",
        fineReferenceNumber: extractedData.fineReferenceNumber || ""
      }
    });

  } catch (error) {
    console.error('Error processing fine extraction:', error);
    res.status(500).json({ 
      error: 'Failed to extract fine data',
      details: error.message 
    });
  }
});

// Appeal check endpoint
app.post('/api/appeal-check', async (req, res) => {
  try {
    const { fineDetails, appealReason } = req.body;
    
    // Validate request data
    if (!fineDetails || !appealReason) {
      return res.status(400).json({ 
        error: 'Missing required fields: fineDetails and appealReason are required' 
      });
    }

    // Create the prompt for ChatGPT
    const prompt = createAppealPrompt(fineDetails, appealReason);
    
    // Call ChatGPT API
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
    
    // Try to parse the JSON response
    let appealAnalysis;
    try {
      appealAnalysis = JSON.parse(response);
    } catch (parseError) {
      // If JSON parsing fails, create a fallback response
      appealAnalysis = {
        appeal_strength: "medium",
        confidence_score: 50,
        reasoning_summary: "Unable to analyze the appeal details properly. Please review your appeal reason and try again."
      };
    }

    // Validate the response structure
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Appeal AI Backend running on port ${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
  console.log(`🤖 Appeal check: http://localhost:${port}/api/appeal-check`);
  console.log(`📷 Extract fine: http://localhost:${port}/api/extract-fine`);
});

module.exports = app;
