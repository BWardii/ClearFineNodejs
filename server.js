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
              text: `You are an expert at extracting parking fine information from official parking fine letters.

Extract the following fields from this parking fine image:

1. fineAmount - The penalty charge amount (numeric value, e.g., "160" or "65.00")
2. infractionDate - The date the violation occurred (format: YYYY-MM-DD)
3. locationAddress - The exact parking location where violation occurred
4. carRegistration - The VEHICLE REGISTRATION NUMBER (UK number plate format, e.g., "CH15ANN" or "RE22DTE"). 
   IMPORTANT: Look for text like "Vehicle registration number:" or "Registration:" and extract the exact plate number shown.
   This is usually clearly stated in the letter. Be very accurate.
5. fineReferenceNumber - The ticket/reference number (e.g., "EF99300708")
6. allegedContravention - The reason for the fine/alleged contravention (e.g., "52(m) Falling to comply with a prohibition on certain types of vehicle" or the full contravention text)

Return ONLY a valid JSON object with these exact keys:
{
  "fineAmount": "value",
  "infractionDate": "YYYY-MM-DD",
  "locationAddress": "value",
  "carRegistration": "value",
  "fineReferenceNumber": "value",
  "allegedContravention": "value"
}

NO markdown, NO code blocks, NO explanations. Only valid JSON.`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${imageFile.mimetype};base64,${base64Image}`,
                detail: "auto"
              }
            }
          ]
        }
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
        fineReferenceNumber: extractedData.fineReferenceNumber || "",
        allegedContravention: extractedData.allegedContravention || ""
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
```

---

## 2️⃣ **clearFine/Services/FineExtractionService.swift**

```swift
import Foundation
import UIKit
import Combine

/// Response model from the backend /api/extract-fine endpoint
struct ExtractedFineResponse: Codable {
    let success: Bool
    let data: ExtractedFineData
}

/// Extracted fine data from OpenAI Vision
struct ExtractedFineData: Codable {
    let fineAmount: String
    let infractionDate: String
    let locationAddress: String
    let carRegistration: String
    let fineReferenceNumber: String
    let allegedContravention: String?
    
    enum CodingKeys: String, CodingKey {
        case fineAmount
        case infractionDate
        case locationAddress
        case carRegistration
        case fineReferenceNumber
        case allegedContravention
    }
}

/// Custom error types for fine extraction
enum FineExtractionError: LocalizedError {
    case noImage
    case invalidURL
    case networkError(Error)
    case invalidResponse
    case decodingError(Error)
    case serverError(String)
    case noConnection
    case uploadFailed(String)
    
    var errorDescription: String? {
        switch self {
        case .noImage:
            return "No image provided for extraction"
        case .invalidURL:
            return "Invalid backend URL"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .invalidResponse:
            return "Invalid response from server"
        case .decodingError(let error):
            return "Failed to decode response: \(error.localizedDescription)"
        case .serverError(let message):
            return "Server error: \(message)"
        case .noConnection:
            return "No internet connection available"
        case .uploadFailed(let reason):
            return "Upload failed: \(reason)"
        }
    }
    
    var recoverySuggestion: String? {
        switch self {
        case .noImage:
            return "Please select or capture a parking fine image"
        case .invalidURL:
            return "Check your backend URL configuration"
        case .networkError:
            return "Please check your internet connection and try again"
        case .invalidResponse, .decodingError:
            return "Try uploading a clearer image of the parking fine"
        case .serverError:
            return "Please try again later"
        case .noConnection:
            return "Please connect to the internet and try again"
        case .uploadFailed:
            return "Please try uploading the image again"
        }
    }
}

/// Service responsible for uploading images to backend and extracting fine data
class FineExtractionService: ObservableObject {
    @Published var isExtracting = false
    @Published var lastError: FineExtractionError?
    
    private let session: URLSession
    private let backendURL: String
    private var cancellables = Set<AnyCancellable>()
    
    /// Initialize with backend URL
    /// - Parameter backendURL: The base URL of the backend server (default: Render deployment)
    init(backendURL: String = "https://clearfinenodejs.onrender.com") {
        self.backendURL = backendURL
        
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = true
        
        self.session = URLSession(configuration: config)
    }
    
    /// Upload an image to extract fine data
    /// - Parameters:
    ///   - image: The UIImage of the parking fine
    ///   - completion: Callback with extracted data or error
    func extractFineData(from image: UIImage, completion: @escaping (Result<ExtractedFineData, FineExtractionError>) -> Void) {
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            let error = FineExtractionError.noImage
            DispatchQueue.main.async {
                self.lastError = error
                completion(.failure(error))
            }
            return
        }
        
        guard let url = URL(string: "\(backendURL)/api/extract-fine") else {
            let error = FineExtractionError.invalidURL
            DispatchQueue.main.async {
                self.lastError = error
                completion(.failure(error))
            }
            return
        }
        
        DispatchQueue.main.async {
            self.isExtracting = true
            self.lastError = nil
        }
        
        let boundary = UUID().uuidString
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        
        // Build multipart form data
        var body = Data()
        
        // Add image data
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"image\"; filename=\"fine.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n".data(using: .utf8)!)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        
        request.httpBody = body
        
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                defer { self?.isExtracting = false }
                
                // Handle network errors
                if let error = error {
                    let extractionError = FineExtractionError.networkError(error)
                    self?.lastError = extractionError
                    completion(.failure(extractionError))
                    return
                }
                
                // Validate response
                guard let httpResponse = response as? HTTPURLResponse else {
                    let error = FineExtractionError.invalidResponse
                    self?.lastError = error
                    completion(.failure(error))
                    return
                }
                
                // Handle HTTP errors
                if httpResponse.statusCode != 200 {
                    var errorMessage = "HTTP \(httpResponse.statusCode)"
                    
                    if let data = data,
                       let errorResponse = try? JSONDecoder().decode([String: String].self, from: data),
                       let error = errorResponse["error"] {
                        errorMessage = error
                    }
                    
                    let extractionError = FineExtractionError.serverError(errorMessage)
                    self?.lastError = extractionError
                    completion(.failure(extractionError))
                    return
                }
                
                // Parse response data
                guard let data = data else {
                    let error = FineExtractionError.invalidResponse
                    self?.lastError = error
                    completion(.failure(error))
                    return
                }
                
                do {
                    let decoder = JSONDecoder()
                    let response = try decoder.decode(ExtractedFineResponse.self, from: data)
                    completion(.success(response.data))
                } catch {
                    let extractionError = FineExtractionError.decodingError(error)
                    self?.lastError = extractionError
                    completion(.failure(extractionError))
                }
            }
        }.resume()
    }
    
    /// Publisher-based extraction for Combine integration
    func extractFineDataPublisher(from image: UIImage) -> AnyPublisher<ExtractedFineData, FineExtractionError> {
        return Future { [weak self] promise in
            self?.extractFineData(from: image) { result in
                promise(result)
            }
        }
        .eraseToAnyPublisher()
    }
}
```

---

## 3️⃣ **clearFine/ViewModels/FineEntryViewModel.swift**

```swift
import Foundation
import UIKit
import Combine

class FineEntryViewModel: ObservableObject {
    @Published var referenceNumber = ""
    @Published var issueDate = Date()
    @Published var dueDate = Calendar.current.date(byAdding: .day, value: 28, to: Date()) ?? Date()
    @Published var discountExpiryDate: Date?
    @Published var location = ""
    @Published var amount = ""
    @Published var discountAmount = ""
    @Published var issuingAuthority = ""
    @Published var vehicleRegistration = ""
    @Published var offenseType = ""
    @Published var offenseDescription = ""
    @Published var notes = ""
    @Published var fineImage: UIImage?
    
    @Published var hasEarlyPaymentDiscount = false
    @Published var isProcessingOCR = false
    @Published var isExtractingWithAI = false
    @Published var extractionError: String?
    @Published var showImagePicker = false
    @Published var showCamera = false
    @Published var validationErrors: [String] = []
    @Published var showValidationAlert = false
    @Published var showExtractionErrorAlert = false
    
    private let dataService: DataService
    private let ocrService: OCRService
    private let extractionService: FineExtractionService
    private let authService: AuthenticationService
    private var cancellables = Set<AnyCancellable>()
    
    init(dataService: DataService, ocrService: OCRService, authService: AuthenticationService) {
        self.dataService = dataService
        self.ocrService = ocrService
        self.extractionService = FineExtractionService()
        self.authService = authService
        
        setupBindings()
        setupDefaultValues()
    }
    
    private func setupBindings() {
        // Update discount expiry date when issue date changes
        $issueDate
            .sink { [weak self] newDate in
                if self?.hasEarlyPaymentDiscount == true {
                    self?.discountExpiryDate = Calendar.current.date(byAdding: .day, value: 14, to: newDate)
                }
            }
            .store(in: &cancellables)
        
        // Update due date when issue date changes
        $issueDate
            .sink { [weak self] newDate in
                self?.dueDate = Calendar.current.date(byAdding: .day, value: 28, to: newDate) ?? newDate
            }
            .store(in: &cancellables)
        
        // Handle early payment discount toggle
        $hasEarlyPaymentDiscount
            .sink { [weak self] hasDiscount in
                if hasDiscount {
                    self?.discountExpiryDate = Calendar.current.date(byAdding: .day, value: 14, to: self?.issueDate ?? Date())
                } else {
                    self?.discountExpiryDate = nil
                    self?.discountAmount = ""
                }
            }
            .store(in: &cancellables)
        
        // Monitor OCR processing
        ocrService.$isProcessing
            .assign(to: \.isProcessingOCR, on: self)
            .store(in: &cancellables)
    }
    
    private func setupDefaultValues() {
        issuingAuthority = "City Council"
        offenseType = "Parking Violation"
    }
    
    // MARK: - OCR Processing (Local)
    func processImageWithOCR(_ image: UIImage) {
        fineImage = image
        
        ocrService.processImage(image) { [weak self] result in
            DispatchQueue.main.async {
                self?.handleOCRResult(result)
            }
        }
    }
    
    // MARK: - AI Extraction (Backend)
    /// Extract fine data using AI backend
    func extractFineDataWithAI(_ image: UIImage) {
        fineImage = image
        
        extractionService.extractFineData(from: image) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let extractedData):
                    self?.handleAIExtractionResult(extractedData)
                    
                case .failure(let error):
                    self?.extractionError = error.localizedDescription
                    self?.showExtractionErrorAlert = true
                }
            }
        }
    }
    
    private func handleAIExtractionResult(_ extractedData: ExtractedFineData) {
        // Parse the infraction date string - try multiple formats
        let infractionDate = parseFlexibleDate(extractedData.infractionDate)
        
        // Populate form fields with extracted data
        if referenceNumber.isEmpty {
            referenceNumber = extractedData.fineReferenceNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        
        if infractionDate != nil {
            issueDate = infractionDate ?? issueDate
        }
        
        if location.isEmpty {
            location = extractedData.locationAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        
        if amount.isEmpty {
            amount = extractedData.fineAmount
        }
        
        if vehicleRegistration.isEmpty {
            vehicleRegistration = extractedData.carRegistration.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        
        if offenseDescription.isEmpty, let contravention = extractedData.allegedContravention {
            offenseDescription = contravention.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        
        // Clear any extraction error since it succeeded
        extractionError = nil
    }
    
    /// Parse date string in various formats
    private func parseFlexibleDate(_ dateString: String) -> Date? {
        let dateFormats = [
            "yyyy-MM-dd",
            "dd/MM/yyyy",
            "dd-MM-yyyy",
            "d/M/yyyy",
            "d-M-yyyy",
            "dd.MM.yyyy",
            "MMMM dd, yyyy",
            "dd MMMM yyyy"
        ]
        
        for format in dateFormats {
            let formatter = DateFormatter()
            formatter.dateFormat = format
            formatter.locale = Locale(identifier: "en_GB")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            
            if let date = formatter.date(from: dateString.trimmingCharacters(in: .whitespacesAndNewlines)) {
                return date
            }
        }
        
        return nil
    }
    
    private func handleOCRResult(_ result: OCRResult?) {
        guard let result = result else { return }
        
        // Only populate empty fields to avoid overwriting user input
        if referenceNumber.isEmpty, let ref = result.referenceNumber {
            referenceNumber = ref
        }
        
        if let issueDate = result.issueDate {
            self.issueDate = issueDate
        }
        
        if let dueDate = result.dueDate {
            self.dueDate = dueDate
        }
        
        if location.isEmpty, let location = result.location {
            self.location = location
        }
        
        if amount.isEmpty, let amount = result.amount {
            self.amount = String(format: "%.2f", amount)
        }
        
        if discountAmount.isEmpty, let discountAmount = result.discountAmount {
            self.discountAmount = String(format: "%.2f", discountAmount)
            hasEarlyPaymentDiscount = true
        }
        
        if issuingAuthority.isEmpty || issuingAuthority == "City Council",
           let authority = result.issuingAuthority {
            issuingAuthority = authority
        }
        
        if vehicleRegistration.isEmpty, let registration = result.vehicleRegistration {
            vehicleRegistration = registration
        }
        
        if offenseType.isEmpty || offenseType == "Parking Violation",
           let type = result.offenseType {
            offenseType = type
        }
        
        if offenseDescription.isEmpty, let description = result.offenseDescription {
            offenseDescription = description
        }
    }
    
    func saveFine() -> Bool {
        guard validateForm() else {
            showValidationAlert = true
            return false
        }
        
        let imageData = fineImage?.jpegData(compressionQuality: 0.8)
        
        let fine = dataService.createFine(
            referenceNumber: referenceNumber.trimmingCharacters(in: .whitespacesAndNewlines),
            issueDate: issueDate,
            dueDate: dueDate,
            discountExpiryDate: hasEarlyPaymentDiscount ? discountExpiryDate : nil,
            location: location.trimmingCharacters(in: .whitespacesAndNewlines),
            amount: Double(amount) ?? 0.0,
            discountAmount: hasEarlyPaymentDiscount ? (Double(discountAmount) ?? 0.0) : 0.0,
            issuingAuthority: issuingAuthority.trimmingCharacters(in: .whitespacesAndNewlines),
            vehicleRegistration: vehicleRegistration.trimmingCharacters(in: .whitespacesAndNewlines),
            offenseType: offenseType.trimmingCharacters(in: .whitespacesAndNewlines),
            offenseDescription: offenseDescription.trimmingCharacters(in: .whitespacesAndNewlines),
            imageData: imageData,
            notes: notes.isEmpty ? nil : notes.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        
        // Schedule notifications
        if let currentUser = authService.currentUser {
            NotificationService.shared.scheduleNotificationsForFine(fine, user: currentUser)
        }
        
        resetForm()
        return true
    }
    
    private func validateForm() -> Bool {
        validationErrors.removeAll()
        
        if referenceNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            validationErrors.append("Reference number is required")
        }
        
        if location.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            validationErrors.append("Location is required")
        }
        
        if amount.isEmpty || Double(amount) == nil || Double(amount)! <= 0 {
            validationErrors.append("Valid fine amount is required")
        }
        
        if hasEarlyPaymentDiscount {
            if discountAmount.isEmpty || Double(discountAmount) == nil || Double(discountAmount)! <= 0 {
                validationErrors.append("Valid discount amount is required")
            } else if let originalAmount = Double(amount),
                      let discount = Double(discountAmount),
                      discount >= originalAmount {
                validationErrors.append("Discount amount must be less than fine amount")
            }
        }
        
        if issuingAuthority.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            validationErrors.append("Issuing authority is required")
        }
        
        if vehicleRegistration.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            validationErrors.append("Vehicle registration is required")
        }
        
        if offenseType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            validationErrors.append("Offense type is required")
        }
        
        if dueDate <= issueDate {
            validationErrors.append("Due date must be after issue date")
        }
        
        if hasEarlyPaymentDiscount,
           let discountExpiry = discountExpiryDate,
           discountExpiry <= issueDate || discountExpiry >= dueDate {
            validationErrors.append("Discount expiry date must be between issue date and due date")
        }
        
        return validationErrors.isEmpty
    }
    
    func resetForm() {
        referenceNumber = ""
        issueDate = Date()
        dueDate = Calendar.current.date(byAdding: .day, value: 28, to: Date()) ?? Date()
        discountExpiryDate = nil
        location = ""
        amount = ""
        discountAmount = ""
        issuingAuthority = "City Council"
        vehicleRegistration = ""
        offenseType = "Parking Violation"
        offenseDescription = ""
        notes = ""
        fineImage = nil
        hasEarlyPaymentDiscount = false
        validationErrors.removeAll()
        extractionError = nil
    }
}
```

---

## ✅ **Push All Three Files to GitHub**

```bash
git add backend/server.js clearFine/Services/FineExtractionService.swift clearFine/ViewModels/FineEntryViewModel.swift
git commit -m "Add alleged contravention extraction with improved vehicle registration accuracy"
git push origin main
```

Deploy in 2-3 minutes, then test! 🚀
