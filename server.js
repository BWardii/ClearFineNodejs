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
  useTempFiles: false
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Appeal AI Backend is running' });
});

// Extract fine data from image using OpenAI Vision
app.post('/api/extract-fine', async (req, res) => {
  try {
    console.log('=== Extract Fine Request Received ===');
    console.log('Files:', req.files ? Object.keys(req.files) : 'NONE');
    
    if (!req.files || !req.files.image) {
      console.error('ERROR: No image file');
      return res.status(400).json({ error: 'No image file provided' });
    }

    const imageFile = req.files.image;
    const imageBuffer = imageFile.data;

    console.log(`File: ${imageFile.name}`);
    console.log(`MIME: ${imageFile.mimetype}`);
    console.log(`Buffer size: ${imageBuffer.length} bytes`);
    
    // Validate we have actual data
    if (!imageBuffer || imageBuffer.length === 0) {
      console.error('ERROR: Image buffer is empty');
      return res.status(400).json({ error: 'Image file is empty' });
    }

    // Convert to base64
    const base64Image = imageBuffer.toString('base64');
    console.log(`Base64 length: ${base64Image.length}`);

    if (!base64Image || base64Image.length === 0) {
      console.error('ERROR: Failed to encode to base64');
      return res.status(400).json({ error: 'Failed to process image' });
    }

    console.log('✓ Image data ready, calling OpenAI...');

    // Call OpenAI Vision API
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract parking fine information from this image. Return JSON with:
- fineAmount: numeric value (e.g., "65.00")
- infractionDate: YYYY-MM-DD format
- locationAddress: parking location
- carRegistration: vehicle plate
- fineReferenceNumber: ticket/reference number

Return ONLY valid JSON object, no markdown, no code blocks.`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${imageFile.mimetype};base64,${base64Image}`,
                detail: "auto"
              }
            }
          ]
        },
        // NEW LOGGING for usage/tracking on extract endpoint
        console.log('OpenAI Usage/Tracking (Extract):', JSON.stringify({
          model: response.model,
          usage: response.usage,
          request_id: response.id
        })),
        // END NEW LOGGING
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: "json_object" }
    });

    console.log('✓ OpenAI response received');
    let extractedText = response.choices[0].message.content;

    // Remove markdown code blocks if present
    extractedText = extractedText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    console.log('Cleaned response:', extractedText);

    // Parse JSON
    const extractedData = JSON.parse(extractedText);
    console.log('✓ Data extracted successfully');

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
    console.error('ERROR:', error.message);
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
    
    // NEW AUDIT LOGGING: Check the raw input data to debug 'undefined' issue
    console.log('--- Received Input Data ---');
    console.log('fineDetails:', fineDetails);
    console.log('appealReason:', appealReason);
    console.log('---------------------------');

    // Create the prompt for ChatGPT
    const prompt = createAppealPrompt(fineDetails, appealReason);
    
    // NEW AUDIT LOGGING: Log the final prompt sent to AI
    console.log('--- Appeal Prompt Sent to AI ---');
    console.log(prompt);
    console.log('-------------------------------');

    // Call ChatGPT API
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert parking fine appeals advisor. Analyze the provided fine details and appeal reason, then determine the likelihood of a successful appeal. Respond with a JSON object containing: appeal_strength (strong/medium|weak), confidence_score (0-100), and reasoning_summary (max 2 sentences)."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7, // FIXED: Increased temperature for more variance
      max_tokens: 1024 // FIXED: Increased token limit to prevent truncation errors
    });

    const response = completion.choices[0].message.content;
    
    // NEW AUDIT LOGGING: Log usage and request ID for tracking
    console.log('OpenAI Usage/Tracking (Appeal):', JSON.stringify({
      model: completion.model,
      usage: completion.usage,
      request_id: completion.id
    }));
    // END NEW LOGGING
    
    // Try to parse the JSON response
    let appealAnalysis;
    let cleanResponse = response;
    
    // FIXED: Aggressive JSON cleaning and extraction using regex
    const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/m); // Capture anything between the first { and the last }

    if (jsonMatch && jsonMatch[0]) {
      cleanResponse = jsonMatch[0];
    } else {
      console.error("FATAL CLEANING ERROR: Could not extract clean JSON block from AI response. Original Response:", response);
      throw new Error("AI response format was invalid and could not be parsed.");
    }
    // END FIXED

    try {
      appealAnalysis = JSON.parse(cleanResponse);
    } catch (parseError) {
      // If JSON parsing fails, log the error and provide a fallback response
      console.error('ERROR: Failed to parse AI response to JSON:', parseError.message);
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
