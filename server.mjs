import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* 🔥 FIREBASE ADMIN SDK INIT */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}
const db = admin.firestore();

/* 🔑 GEMINI AI CONFIG */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * 🔍 SMART SEARCH: Search medicine based on symptoms & doctor's pathy
 */
async function searchDoctorUsage(symptoms, pathy) {
    let medicines = [];
    for (const sym of symptoms) {
        const snapshot = await db.collection("doctor_uses")
            .where("symptom", "==", sym.toLowerCase())
            .where("doctor_pathy", "==", pathy) // Only match same pathy
            .orderBy("usage_count", "desc")
            .limit(2)
            .get();

        snapshot.forEach((doc) => medicines.push(doc.data().medicine_name));
    }
    return [...new Set(medicines)];
}

/**
 * 💾 AUTO-LEARNING: Save successful combinations
 */
async function updateDoctorUsage(doctor_id, pathy, symptoms, medicines) {
    const batch = db.batch();
    for (const sym of symptoms) {
        for (const med of medicines) {
            const comboId = Buffer.from(`${sym}_${med}_${pathy}`).toString('base64');
            const docRef = db.collection("doctor_uses").doc(comboId);
            
            batch.set(docRef, {
                doctor_id,
                doctor_pathy: pathy,
                symptom: sym.toLowerCase(),
                medicine_name: med.toLowerCase(),
                usage_count: admin.firestore.FieldValue.increment(1),
                last_used: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
    }
    await batch.commit();
}

/* 🚀 ANALYZE API (GLOBAL & LOCAL SUPPORT) */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id, doctor_pathy = "Allopathy", country = "India" } = req.body;

        if (!text) return res.status(400).json({ error: "No text provided" });

        // 1. Pathy & Location Specific Instructions
        const systemInstruction = `
        You are an expert medical assistant for a ${doctor_pathy} doctor in ${country}.
        Analyze the patient text and extract symptoms.
        
        RULES:
        1. If pathy is 'Electro-Homeopathy', suggest EH remedies (S1, F1, BE, etc.).
        2. If pathy is 'Allopathy', suggest safe Generic medicines.
        3. Support Local Languages: Extract keywords even if text is in Hinglish or Local Dialects.
        4. Return clinical keywords in English for database matching.
        5. Severity must be 'Low', 'Medium', or 'High'.
        6. Medicines must be common in ${country}.
        `;

        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: systemInstruction,
        });

        // 2. Strict JSON Schema
        const prompt = `
        Analyze this text: "${text}"
        Return JSON format:
        {
          "symptoms": ["English term"],
          "medicines": ["Name Only"],
          "diet": [],
          "exercise": [],
          "precautions": [],
          "severity": ""
        }`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let aiText = response.text().replace(/```json|```/g, "").trim();
        const aiResponse = JSON.parse(aiText);

        // 3. Smart Search (Check if Doctor has used these before)
        const learnedMedicines = await searchDoctorUsage(aiResponse.symptoms, doctor_pathy);

        // If we have learned medicines, prioritize them
        const finalMedicines = learnedMedicines.length > 0 ? learnedMedicines : aiResponse.medicines;

        // 4. Learning logic (If Gemini suggested new things)
        if (learnedMedicines.length === 0 && finalMedicines.length > 0) {
            await updateDoctorUsage(doctor_id, doctor_pathy, aiResponse.symptoms, finalMedicines);
        }

        res.json({
            ...aiResponse,
            medicines: finalMedicines,
            doctor_id,
            doctor_pathy,
            engine: learnedMedicines.length > 0 ? "Database" : "AI"
        });

    } catch (error) {
        console.error("Analysis Error:", error);
        res.status(500).json({ error: "Server Error", msg: error.message });
    }
});

/* 💾 SAVE MANUAL PRESCRIPTION (Force Learning) */
app.post("/save-prescription", async (req, res) => {
    try {
        const { doctor_id, doctor_pathy, symptoms, medicines } = req.body;
        await updateDoctorUsage(doctor_id, doctor_pathy, symptoms, medicines);
        res.json({ success: true, message: "Learned successfully" });
    } catch (error) {
        res.status(500).json({ error: "Save failed", msg: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🔥 Zeqvex Global Engine Live on Port ${PORT}`);
});
