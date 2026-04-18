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

const MASTER_PROMPT = `You are a Senior Consultant Medical Doctor.
TASKS: Translate complaints to Clinical English, Provide Diagnosis, and Prescribe Medicines.
PATHY: If 'electrohomeopathy', use EH remedies. If 'allopathy', use standard drugs.
FORMAT: JSON ONLY.`;

/* 🔥 GEMINI CALLER */
async function callGemini(text, pathy) {
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
  } catch (e) { return safeJSON(""); }
}

/* 🔥 ANALYZE ENDPOINT (Database First, Gemini Second) */
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

    // Step 2: Check Medicine Master for matched symptoms
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
    // Logic: Agar DB mein kam se kam 3 medicines mil jayein toh Gemini ko skip karo
    if (dbMeds.length >= 3) {
      finalData = { 
        symptoms: [...new Set(symptomsList)], 
        diagnosis: "Verified from clinic database", 
        medicines: dbMeds, 
        source: "local_db" 
      };
    } else {
      // Fallback: Gemini ko call karo agar DB weak hai
      const ai = await callGemini(text, doctor_pathy);
      finalData = { ...ai, source: "gemini" };
    }

    finalData.prescription_id = db.collection("prescriptions").doc().id;
    res.json(finalData);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🔥 SMART SAVE ENDPOINT - VYONALIFE CONCEPT */
app.post("/save-prescription", async (req, res) => {
  try {
    const { 
      prescription_id, 
      doctor_id, 
      patient_id, 
      doctor_pathy, 
      medicines, 
      symptoms, 
      source // "gemini", "edited", ya "direct"
    } = req.body;

    const batch = db.batch();
    const ts = new Date();

    // 1. Hamesha: Main Prescription save karo
    batch.set(db.collection("prescriptions").doc(prescription_id), {
      doctor_id, patient_id, doctor_pathy, medicines, symptoms, source, created_at: ts
    });

    (medicines || []).forEach(m => {
      const medName = normalize(m.name);
      const medId = `${doctor_pathy}_${medName.replace(/\s+/g, '_')}`;

      // 2. Hamesha: Doctor Uses Collection (Tracking ke liye)
      batch.set(db.collection("doctor_uses").doc(), { 
        doctor_id, medicine_name: medName, symptoms, doctor_pathy, type: source, created_at: ts 
      });

      // --- SMART LOGIC STARTS HERE ---

      // A. Agar doctor ne Gemini ka data edit kiya toh AI_LEARNING mein dalo
      if (source === "edited") {
        batch.set(db.collection("ai_learning").doc(), {
          input_symptoms: symptoms,
          doctor_medicine: medName,
          pathy: doctor_pathy,
          doctor_id: doctor_id,
          timestamp: ts
        });
      } 

      // B. Gemini ka data (Fallback) ya Doctor ka Direct data hamesha DB ko bharega
      // Isse aapka Medicine Master aur Keywords strong honge
      if (source === "gemini" || source === "direct" || source === "edited") {
        
        // Update Medicine Master
        const masterRef = db.collection("medicine_master").doc(medId);
        batch.set(masterRef, {
          name: m.name,
          pathy: doctor_pathy,
          symptoms: admin.firestore.FieldValue.arrayUnion(...symptoms),
          usage_count: admin.firestore.FieldValue.increment(1),
          verified: source !== "gemini", // Dr ka data verified, Gemini raw
          updated_at: ts
        }, { merge: true });

        // Update Symptoms Keywords (Sabse important Gemini fallback ke liye)
        symptoms.forEach(sym => {
          const symKey = normalize(sym).replace(/\s+/g, '_');
          batch.set(db.collection("symptoms_keywords").doc(symKey), {
            symptom: sym,
            keywords_lowercase: admin.firestore.FieldValue.arrayUnion(normalize(sym))
          }, { merge: true });
        });
      }
    });

    await batch.commit();
    res.json({ success: true, message: "ZEQVEX DB Stronger Now!" });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

/* 🔐 OTHER ENDPOINTS */
app.post("/request-access", async (req, res) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await db.collection("otp_sessions").add({ 
    otp, patient_id: req.body.patient_id, doctor_id: req.body.doctor_id, used: false, created_at: Date.now() 
  });
  res.json({ success: true, otp }); 
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 ZEQVEX v2.0 READY (Gemini 2.5 Flash)`));
