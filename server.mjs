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

/* 🔥 THE "DHEET" JSON PARSER (Ab fail nahi hoga) */
function safeJSON(txt) {
  try {
    if (!txt) throw new Error("Empty text");
    
    // Kachra saaf karo (Markdown, extra spaces)
    let clean = txt.replace(/```json/g, "").replace(/```/g, "").trim();
    
    // JSON ka bracket dhundo
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    
    if (start !== -1 && end !== -1) {
      clean = clean.substring(start, end + 1);
      const parsed = JSON.parse(clean);
      
      // Ensure medicines is always an array
      if (!Array.isArray(parsed.medicines)) parsed.medicines = [];
      return parsed;
    }
    throw new Error("No JSON found in text");
  } catch (e) {
    console.log("⚠️ Raw Gemini Text for Debugging:", txt); // Render logs mein dikhega
    return { 
      symptoms: ["Analysis Done"], 
      diagnosis: "Clinical evaluation complete", 
      medicines: [], 
      diet: ["Drink warm water"], exercise: ["Rest"], precautions: ["Monitor health"] 
    };
  }
}

/* 🔥 MASTER PROMPT (Simplified & Direct) */
const MASTER_PROMPT = `Act as a senior specialist.
RULES:
1. Support ANY language. Output MUST be in English.
2. If pathy is "electrohomeopathy", use EH remedies (S1, F1, A2, BE, etc.).
3. Return ONLY a JSON object. No intro.

JSON STRUCTURE:
{
  "symptoms": ["Symptom 1", "Symptom 2"],
  "diagnosis": "Clinical Diagnosis",
  "medicines": [{"name": "Name", "type": "primary", "pathy": "Pathy Name", "dosage": "Dose", "duration": "Days"}],
  "diet": [],
  "exercise": [],
  "precautions": []
}`;

/* 🔥 GEMINI CALLER */
async function callGemini(text, pathy) {
  const prompt = `System: ${pathy} doctor.\nPatient Input: ${text}\n\nTask: Extract symptoms and provide prescription in JSON.\n\n${MASTER_PROMPT}`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: prompt }] }]
      }),
    });
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return safeJSON(txt);
  } catch (e) { 
    console.error("❌ Gemini API Critical Error:", e.message);
    return safeJSON(""); 
  }
}

/* 🔥 1. SYMPTOMS MAPPING */
async function mapSymptoms(input) {
  input = input.toLowerCase();
  const result = new Set();
  try {
    const snap = await db.collection("symptoms_keywords").get();
    snap.forEach(doc => {
      const d = doc.data();
      (d.keywords_lowercase || []).forEach(k => { if (input.includes(k)) result.add(d.symptom); });
    });
  } catch (e) { console.error("DB Map Error:", e); }
  return [...result];
}

/* 🔥 2. DATABASE SEARCH */
async function getFromDB(symptoms, pathy) {
  const map = new Map();
  if (symptoms.length === 0) return [];
  try {
    for (const sym of symptoms) {
      const snap = await db.collection("medicine_master")
        .where("pathy", "==", pathy)
        .where("symptoms", "array-contains", sym)
        .get();
      snap.forEach(d => map.set(d.id, d.data()));
    }
  } catch (e) { console.error("DB Search Error:", e); }
  return [...map.values()];
}

/* 🔥 3. ANALYZE (Puchne Ke Liye) */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_pathy = "allopathy" } = req.body;
    if (!text) return res.status(400).json({ error: "No text provided" });

    const cacheKey = `${doctor_pathy}_${text.slice(0, 30)}`;
    if (localCache.has(cacheKey)) return res.json(localCache.get(cacheKey));

    let symptoms = await mapSymptoms(text);
    let dbMeds = await getFromDB(symptoms, doctor_pathy);
    
    let finalData;

    if (dbMeds.length >= 3) {
      finalData = {
        symptoms: symptoms,
        diagnosis: "Record-based clinical match",
        medicines: dbMeds,
        diet: ["Follow routine"], exercise: ["As advised"], precautions: ["Standard tips"],
        source: "local_db"
      };
    } else {
      const ai = await callGemini(text, doctor_pathy);
      finalData = { ...ai, source: "gemini" };
    }

    finalData.prescription_id = db.collection("prescriptions").doc().id;
    localCache.set(cacheKey, finalData);
    res.json(finalData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔥 4. SAVE PRESCRIPTION */
app.post("/save-prescription", async (req, res) => {
  try {
    const { prescription_id, doctor_id, patient_id, doctor_pathy, medicines, symptoms, source } = req.body;

    if (!prescription_id) return res.status(400).json({ error: "prescription_id missing" });

    await db.collection("prescriptions").doc(prescription_id).set({
      doctor_id, patient_id, doctor_pathy, medicines, symptoms, source,
      created_at: new Date()
    });

    const batch = db.batch();
    (medicines || []).forEach(m => {
      const name = normalize(m.name);
      batch.set(db.collection("doctor_uses").doc(), {
        doctor_id, medicine_name: name, symptoms, doctor_pathy, type: source, created_at: new Date()
      });

      if (source === "direct" || source === "edited") {
        batch.set(db.collection("medicine_master").doc(name), {
          name, pathy: doctor_pathy, symptoms: symptoms,
          usage_count: admin.firestore.FieldValue.increment(5),
          verified: true, updated_at: new Date()
        }, { merge: true });
      }
    });

    await batch.commit();
    res.json({ success: true, message: "Saved to Console!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔐 5. OTP & HISTORY */
app.post("/request-access", async (req, res) => {
  const { patient_id, doctor_id } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await db.collection("otp_sessions").add({ otp, patient_id, doctor_id, used: false, created_at: Date.now() });
  res.json({ success: true, otp }); 
});

app.post("/verify-otp", async (req, res) => {
  const { otp } = req.body;
  const snap = await db.collection("otp_sessions").where("otp", "==", otp).where("used", "==", false).limit(1).get();
  if (snap.empty) return res.status(400).json({ error: "Invalid OTP" });
  await snap.docs[0].ref.update({ used: true });
  res.json({ success: true });
});

app.post("/patient-history", async (req, res) => {
  const { patient_id } = req.body;
  const snap = await db.collection("prescriptions").where("patient_id", "==", patient_id).orderBy("created_at", "desc").get();
  const data = []; snap.forEach(doc => data.push(doc.data()));
  res.json(data);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 ZEQVEX v1.7.1 LIVE ON PORT ${PORT}`));
