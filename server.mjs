import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors(), express.json({ limit: '50mb' })); // Large size for image analysis

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
const MODEL = "gemini-2.0-flash"; // Optimized for Vision & Speed

const normalize = (t) => t?.toLowerCase().trim();
const OTP_EXPIRY_MS = 5 * 60 * 1000;

/* 🔥 CACHE SYSTEM (Saves money and time) */
const localCache = new Map();

/* 🔥 SAFE JSON */
function safeJSON(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return { symptoms: [], diagnosis: "", medicines: [], diet: [], exercise: [], precautions: [] };
  }
}

/* 🔥 MASTER PROMPT */
const MASTER_PROMPT = `
You are a highly experienced and globally trained medical doctor.
IMPORTANT RULES:
1. forstå/understand any language, but respond in PROFESSIONAL MEDICAL ENGLISH.
2. PATHY LOGIC: Respect the requested doctor_pathy (Allopathy, Ayurveda, Homeopathy, Electro_Homeopathy).
3. Return STRICT JSON only.
{
"symptoms": [], "diagnosis": "",
"medicines": [{"name": "", "type": "primary", "pathy": "", "dosage": "", "duration": ""}],
"diet": [], "exercise": [], "precautions": []
}
`;

/* 🔥 GEMINI CALL */
async function callGemini(text, pathy, imageData = null) {
  const prompt = `Context: ${pathy} doctor. \n ${MASTER_PROMPT}`;
  
  const payload = {
    contents: [{
      parts: [
        { text: text + "\n" + prompt },
        ...(imageData ? [{ inline_data: { mime_type: "image/jpeg", data: imageData } }] : [])
      ]
    }]
  };

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    let txt = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    txt = txt.replace(/```json|```/g, "").trim();
    return safeJSON(txt);
  } catch { return safeJSON(""); }
}

/* 🔥 UPGRADE 1: ANALYZE LAB REPORTS (VISION) */
app.post("/analyze-report", async (req, res) => {
  try {
    const { image_base64, doctor_pathy = "allopathy" } = req.body;
    if (!image_base64) return res.status(400).json({ error: "Image data required" });

    const ai = await callGemini("Analyze this medical report/image and provide diagnosis.", doctor_pathy, image_base64);
    res.json(ai);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔥 SYMPTOMS KEYWORD MAPPING */
async function mapSymptoms(input) {
  input = input.toLowerCase();
  const result = new Set();
  const snap = await db.collection("symptoms_keywords").get();
  snap.forEach(doc => {
    const d = doc.data();
    (d.keywords_lowercase || []).forEach(k => { if (input.includes(k)) result.add(d.symptom); });
  });
  return [...result];
}

/* 🔥 DB SEARCH & RANKING */
async function getFromDB(symptoms, pathy) {
  const map = new Map();
  for (const sym of symptoms) {
    const snap = await db.collection("medicine_master").where("pathy", "==", pathy).where("symptoms", "array-contains", sym).get();
    snap.forEach(d => map.set(d.id, d.data()));
  }
  return [...map.values()].map(m => {
    let score = (m.usage_count || 0) * 2;
    if (m.verified) score += 5;
    if (m.source === "doctor") score += 3;
    return { ...m, score };
  }).sort((a, b) => b.score - a.score);
}

/* 🔥 ANALYZE TEXT (With Caching) */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_pathy = "allopathy" } = req.body;
    const cacheKey = `${doctor_pathy}_${text.slice(0, 20)}`;
    if (localCache.has(cacheKey)) return res.json(localCache.get(cacheKey));

    let symptoms = await mapSymptoms(text);
    let dbMeds = await getFromDB(symptoms, doctor_pathy);
    
    let finalData;
    if (dbMeds.length >= 3) {
      finalData = { symptoms, medicines: dbMeds, diagnosis: "Based on clinic records", diet: [], exercise: [], precautions: [] };
    } else {
      const ai = await callGemini(text, doctor_pathy);
      finalData = { ...ai, prescription_id: db.collection("prescriptions").doc().id };
    }

    localCache.set(cacheKey, finalData);
    res.json(finalData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔥 SAVE PRESCRIPTION (Strong DB Logic) */
app.post("/save-prescription", async (req, res) => {
  try {
    const { prescription_id, doctor_id, patient_id, doctor_pathy, medicines, symptoms, source } = req.body;
    
    const pRef = db.collection("prescriptions").doc(prescription_id);
    await pRef.set({ doctor_id, patient_id, doctor_pathy, medicines, symptoms, source, created_at: new Date() });

    const batch = db.batch();
    medicines.forEach(m => {
      const name = normalize(m.name);
      batch.set(db.collection("doctor_uses").doc(), { doctor_id, medicine: name, symptoms, pathy: doctor_pathy, type: source, created_at: new Date() });
      if (source === "direct" || source === "edited") {
        batch.set(db.collection("medicine_master").doc(name), { name, pathy: doctor_pathy, symptoms, usage_count: admin.firestore.FieldValue.increment(2), verified: true, source: "doctor", updated_at: new Date() }, { merge: true });
      }
    });
    await batch.commit();

    // 🔥 UPGRADE 3: PDF Ready Signal
    res.json({ success: true, pdf_url: `https://zeqvex.com/print/${prescription_id}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔐 SECURITY (OTP & History) */
app.post("/request-access", async (req, res) => {
  const { patient_id, doctor_id } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await db.collection("otp_sessions").add({ otp, patient_id, doctor_id, used: false, created_at: Date.now() });
  res.json({ success: true });
});

app.post("/verify-otp", async (req, res) => {
  const { patient_id, doctor_id, otp } = req.body;
  const snap = await db.collection("otp_sessions").where("patient_id", "==", patient_id).where("doctor_id", "==", doctor_id).where("otp", "==", otp).where("used", "==", false).limit(1).get();
  if (snap.empty) return res.status(400).json({ error: "Invalid" });
  const doc = snap.docs[0];
  if (Date.now() - doc.data().created_at > OTP_EXPIRY_MS) return res.status(400).json({ error: "Expired" });
  await doc.ref.update({ used: true });
  await db.collection("access_logs").add({ patient_id, doctor_id, accessed_at: new Date() });
  res.json({ success: true });
});

app.post("/patient-history", async (req, res) => {
  const { patient_id, doctor_id } = req.body;
  const otpSnap = await db.collection("otp_sessions").where("patient_id", "==", patient_id).where("doctor_id", "==", doctor_id).where("used", "==", true).limit(1).get();
  if (otpSnap.empty) return res.status(403).json({ error: "Unauthorized" });
  const snap = await db.collection("prescriptions").where("patient_id", "==", patient_id).orderBy("created_at", "desc").get();
  const data = []; snap.forEach(doc => data.push(doc.data()));
  res.json(data);
});

app.listen(10000, () => console.log("🚀 ZEQVEX v1.5 POWERED UP"));
 Me db.collection("access_logs").add(...)
