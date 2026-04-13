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

/* 🔥 SAFE JSON PARSER */
function safeJSON(txt) {
  try {
    const cleanTxt = txt.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanTxt);
  } catch (e) {
    console.error("JSON Parse Error:", e);
    return { 
      symptoms: [], diagnosis: "Format Error", medicines: [], 
      diet: [], exercise: [], precautions: [] 
    };
  }
}

/* 🔥 ULTIMATE DOCTOR PROMPT (Fixed for 2.5 Flash) */
const MASTER_PROMPT = `
You are a world-class diagnostic and prescription expert. 
Your goal is to act as a specialist doctor for the requested "doctor_pathy".

STRICT OPERATING PROCEDURES:
1. LANGUAGE: Patients may use local languages (Hindi, Marathi, Hinglish). You must translate these accurately to professional medical English.
2. DIAGNOSIS: Provide a concise, clinical diagnosis based on the symptoms.
3. PATHY LOGIC: 
   - If pathy is "Electro_Homeopathy", use only EH remedies (e.g., S1, F1, A2, etc.).
   - For Allopathy, use standard clinical drugs.
4. COMPLETENESS: Never return empty lists if symptoms are provided. Suggest the most effective safe treatments.
5. OUTPUT: Return ONLY a valid JSON object. No conversational text.

STRUCTURE:
{
  "symptoms": ["Professional term 1", "Professional term 2"],
  "diagnosis": "Clinical Diagnosis Name",
  "medicines": [
    {"name": "Full Name", "type": "primary", "pathy": "pathy_name", "dosage": "e.g. 5 drops 3 times a day", "duration": "e.g. 7 days"}
  ],
  "diet": ["specific food advice"],
  "exercise": ["physical activity advice"],
  "precautions": ["safety warnings"]
}
`;

/* 🔥 GEMINI API CALLER */
async function callGemini(text, pathy, imageData = null) {
  const prompt = `Requested Pathy: ${pathy}\nPatient Complaint: ${text}\n\n${MASTER_PROMPT}`;
  const payload = {
    contents: [{
      parts: [
        { text: prompt },
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
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return safeJSON(txt);
  } catch (e) { return safeJSON(""); }
}

/* 🔥 1. SYMPTOMS MAPPING */
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

/* 🔥 2. DATABASE SEARCH & RANKING */
async function getFromDB(symptoms, pathy) {
  const map = new Map();
  for (const sym of symptoms) {
    const snap = await db.collection("medicine_master")
      .where("pathy", "==", pathy)
      .where("symptoms", "array-contains", sym)
      .get();
    snap.forEach(d => map.set(d.id, d.data()));
  }
  return [...map.values()].map(m => {
    let score = (m.usage_count || 0) * 2;
    if (m.verified) score += 10; // Extra weight for doctor verified
    return { ...m, score };
  }).sort((a, b) => b.score - a.score);
}

/* 🔥 3. ANALYZE TEXT (Smart Logic) */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_pathy = "allopathy" } = req.body;
    const cacheKey = `${doctor_pathy}_${text.slice(0, 30)}`;
    if (localCache.has(cacheKey)) return res.json(localCache.get(cacheKey));

    let symptoms = await mapSymptoms(text);
    let dbMeds = await getFromDB(symptoms, doctor_pathy);
    
    let finalData;

    // 🔥 RULE: Agar hamare DB mein 3 Verified records hain, toh Gemini bypass karo
    if (dbMeds.length >= 3) {
      console.log("🚀 SUCCESS: Using Zeqvex Internal Knowledge Base");
      finalData = {
        symptoms: symptoms.length > 0 ? symptoms : ["Identified from History"],
        diagnosis: "Confirmed via clinical records",
        medicines: dbMeds,
        diet: ["Follow standard protocol"],
        exercise: ["As previously advised"],
        precautions: ["Standard precautions"],
        source: "local_db"
      };
    } else {
      console.log("🤖 AI MODE: Learning from Gemini...");
      const ai = await callGemini(text, doctor_pathy);
      finalData = { ...ai, source: "gemini" };
    }

    finalData.prescription_id = db.collection("prescriptions").doc().id;
    localCache.set(cacheKey, finalData);
    res.json(finalData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔥 4. SAVE PRESCRIPTION (The Learning Engine) */
app.post("/save-prescription", async (req, res) => {
  try {
    const { prescription_id, doctor_id, patient_id, doctor_pathy, medicines, symptoms, source } = req.body;

    // 1. Save Transactional Record
    await db.collection("prescriptions").doc(prescription_id).set({
      doctor_id, patient_id, doctor_pathy, medicines, symptoms, source, created_at: new Date()
    });

    const batch = db.batch();
    medicines.forEach(m => {
      const name = normalize(m.name);

      // 2. Log Usage for Analytics
      batch.set(db.collection("doctor_uses").doc(), {
        doctor_id, medicine_name: name, symptoms, doctor_pathy, 
        type: source, created_at: new Date(), usage_count: 1
      });

      // 3. 🔥 UPDATE MASTER DB (Power Up)
      // Jab doctor Gemini ko edit kare ya apni dawai direct de, tab hamara DB strong hota hai
      if (source === "direct" || source === "edited") {
        batch.set(db.collection("medicine_master").doc(name), {
          name, 
          pathy: doctor_pathy, 
          symptoms: symptoms, // Is bimari ke liye ye dawai link ho gayi
          usage_count: admin.firestore.FieldValue.increment(5), // Isse iski priority badhegi
          verified: true, 
          updated_at: new Date()
        }, { merge: true });
      }
    });

    await batch.commit();
    res.json({ success: true, pdf_url: `https://zeqvex.com/print/${prescription_id}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔐 5. ACCESS & HISTORY */
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
app.listen(PORT, () => console.log(`🚀 ZEQVEX v1.6 LIVE ON PORT ${PORT}`));
