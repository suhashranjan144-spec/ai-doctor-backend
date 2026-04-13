import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors(), express.json({ limit: '50mb' })); 

/* 🔥 FIREBASE INIT */
const serviceAccount = process.env.FIREBASE_KEY
  ? JSON.parse(process.env.FIREBASE_KEY)
  : JSON.parse(fs.readFileSync("./firebase-key.json", "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash"; 

const normalize = (t) => t?.toLowerCase().trim();
const localCache = new Map();

/* 🔥 REFINED JSON PARSER */
function safeJSON(txt) {
  try {
    if (!txt) throw new Error("No response from AI");
    let clean = txt.replace(/```json/g, "").replace(/```/g, "").trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      clean = clean.substring(start, end + 1);
      return JSON.parse(clean);
    }
    throw new Error("Invalid format");
  } catch (e) {
    console.log("⚠️ AI raw response error:", txt);
    return { 
      symptoms: ["Identify Manually"], 
      diagnosis: "AI Response Format Error", 
      medicines: [], diet: [], exercise: [], precautions: [] 
    };
  }
}

/* 🔥 POWERFUL MEDICAL PROMPT (No more childish behavior) */
const MASTER_PROMPT = `
You are a Senior Consultant Medical Doctor.
TASKS:
1. Translate patient complaints from any local language (Hindi/Marathi/Hinglish/Bengali) to Clinical English.
2. Provide a specific Clinical Diagnosis.
3. PRESCRIBE MEDICINES:
   - If pathy is "electrohomeopathy", use EH remedies (S1, F1, A2, C5, L1, BE, WE, RE, etc.).
   - If pathy is "allopathy", use standard clinical drugs.
4. If the input is vague, use clinical judgment to provide the most likely prescription.

STRICT OUTPUT FORMAT (JSON ONLY):
{
  "symptoms": ["Clinical term 1", "Clinical term 2"],
  "diagnosis": "Specific Condition Name",
  "medicines": [{"name": "Exact Name", "type": "primary", "pathy": "Pathy Name", "dosage": "Exact Dose", "duration": "Days"}],
  "diet": ["Clinical diet advice"],
  "exercise": ["Physical recovery advice"],
  "precautions": ["Medical safety tips"]
}`;

/* 🔥 GEMINI CALLER */
async function callGemini(text, pathy) {
  // Pathy name cleaning
  const cleanPathy = pathy.toLowerCase().includes("electro") ? "electrohomeopathy" : pathy;
  const prompt = `Requested Pathy: ${cleanPathy}\nPatient Data: ${text}\n\n${MASTER_PROMPT}`;
  
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: prompt }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      }),
    });
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return safeJSON(txt);
  } catch (e) { 
    return safeJSON(""); 
  }
}

/* 🔥 ANALYZE ENDPOINT (With Local Logic Maintenance) */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_pathy = "allopathy" } = req.body;
    if (!text) return res.status(400).json({ error: "Input text is required" });

    // Step 1: Check Symptoms Keywords in DB
    let symptomsList = [];
    const snap = await db.collection("symptoms_keywords").get();
    snap.forEach(doc => {
      const d = doc.data();
      (d.keywords_lowercase || []).forEach(k => { 
        if (text.toLowerCase().includes(k)) symptomsList.push(d.symptom); 
      });
    });

    // Step 2: Check Medicine Master
    let dbMeds = [];
    if (symptomsList.length > 0) {
      for (const sym of [...new Set(symptomsList)]) {
        const mSnap = await db.collection("medicine_master")
          .where("pathy", "==", doctor_pathy)
          .where("symptoms", "array-contains", sym)
          .get();
        mSnap.forEach(d => dbMeds.push(d.data()));
      }
    }

    let finalData;
    if (dbMeds.length >= 3) {
      finalData = {
        symptoms: [...new Set(symptomsList)],
        diagnosis: "Verified from clinic database",
        medicines: dbMeds,
        diet: ["Follow standard diet"], exercise: ["Rest"], precautions: ["Standard care"],
        source: "local_db"
      };
    } else {
      const ai = await callGemini(text, doctor_pathy);
      finalData = { ...ai, source: "gemini" };
    }

    finalData.prescription_id = db.collection("prescriptions").doc().id;
    res.json(finalData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔥 SAVE PRESCRIPTION (No change, keeping your solid logic) */
app.post("/save-prescription", async (req, res) => {
  try {
    const { prescription_id, doctor_id, patient_id, doctor_pathy, medicines, symptoms, source } = req.body;
    await db.collection("prescriptions").doc(prescription_id).set({
      doctor_id, patient_id, doctor_pathy, medicines, symptoms, source, created_at: new Date()
    });
    const batch = db.batch();
    (medicines || []).forEach(m => {
      const name = normalize(m.name);
      batch.set(db.collection("doctor_uses").doc(), { doctor_id, medicine_name: name, symptoms, doctor_pathy, type: source, created_at: new Date() });
      if (source === "direct" || source === "edited") {
        batch.set(db.collection("medicine_master").doc(name), {
          name, pathy: doctor_pathy, symptoms, usage_count: admin.firestore.FieldValue.increment(5), verified: true, updated_at: new Date()
        }, { merge: true });
      }
    });
    await batch.commit();
    res.json({ success: true, message: "Database Updated!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔐 OTHER ENDPOINTS */
app.post("/request-access", async (req, res) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await db.collection("otp_sessions").add({ otp, patient_id: req.body.patient_id, doctor_id: req.body.doctor_id, used: false, created_at: Date.now() });
  res.json({ success: true, otp }); 
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 ZEQVEX v1.7.2 SECURE` ));
