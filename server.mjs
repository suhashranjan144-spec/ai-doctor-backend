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
    if (!txt) throw new Error("No response");
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
    return null;
  }
}

/* 🔥 GEMINI CALLER (Fallback Engine) */
async function callGemini(text, pathy) {
  const MASTER_PROMPT = `You are a Senior Consultant Doctor. 
  Output valid JSON ONLY with keys: symptoms, diagnosis, medicines (array with name, dosage, duration), diet, exercise, precautions. 
  Pathy Rule: If 'electrohomeopathy', use EH remedies. If 'allopathy', use standard drugs.`;
  
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: `Patient Complaints: ${text}\nRequested Pathy: ${pathy}\n\n${MASTER_PROMPT}` }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      }),
    });
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return safeJSON(txt);
  } catch (e) { return null; }
}

/* 🔥 THE SUPER ENDPOINT: PROCESS, FETCH & AUTO-SAVE */
app.post("/direct-save", async (req, res) => {
  try {
    const { text, doctor_id, patient_id, doctor_pathy = "allopathy", source = "direct" } = req.body;
    if (!text) return res.status(400).json({ error: "Voice/Text input is required" });

    const ts = new Date();
    const batch = db.batch();
    const prescription_id = db.collection("prescriptions").doc().id;

    // --- STEP 1: DB SEARCH (Symptom Matching) ---
    let finalMedicines = [];
    let finalSymptoms = [];
    let dataSource = source;
    let diagnosis = "Diagnosis Pending";

    let matchedSymptoms = [];
    const symSnap = await db.collection("symptoms_keywords").get();
    symSnap.forEach(doc => {
      const d = doc.data();
      (d.keywords_lowercase || []).forEach(k => { 
        if (text.toLowerCase().includes(k)) matchedSymptoms.push(d.symptom); 
      });
    });

    if (matchedSymptoms.length > 0) {
      const uniqueSymptoms = [...new Set(matchedSymptoms)];
      for (const sym of uniqueSymptoms) {
        const mSnap = await db.collection("medicine_master")
          .where("pathy", "==", doctor_pathy)
          .where("symptoms", "array-contains", sym).get();
        mSnap.forEach(d => finalMedicines.push(d.data()));
      }
      finalSymptoms = uniqueSymptoms;
      diagnosis = "Verified from clinic database";
      dataSource = "local_db";
    }

    // --- STEP 2: GEMINI FALLBACK (Agar DB mein medicine nahi mili) ---
    if (finalMedicines.length < 1) {
      const aiResponse = await callGemini(text, doctor_pathy);
      if (aiResponse) {
        // Handle Gemini key variations (remedy vs name)
        finalMedicines = (aiResponse.medicines || aiResponse.medicines_prescribed || []).map(m => ({
          name: m.name || m.remedy,
          dosage: m.dosage,
          duration: m.duration,
          pathy: doctor_pathy
        }));
        finalSymptoms = aiResponse.symptoms || [];
        diagnosis = aiResponse.diagnosis || "AI Generated Diagnosis";
        dataSource = "gemini";
      }
    }

    // --- STEP 3: AUTO-SYNC TO ALL 4 COLLECTIONS ---
    // 1. prescriptions
    batch.set(db.collection("prescriptions").doc(prescription_id), {
      doctor_id, patient_id, doctor_pathy, diagnosis,
      medicines: finalMedicines, symptoms: finalSymptoms, 
      source: dataSource, created_at: ts
    });

    finalMedicines.forEach(m => {
      const medName = normalize(m.name);
      const medId = `${doctor_pathy}_${medName.replace(/\s+/g, '_')}`;

      // 2. doctor_uses (Hamesha tracking ke liye)
      batch.set(db.collection("doctor_uses").doc(), { 
        doctor_id, medicine_name: medName, symptoms: finalSymptoms, doctor_pathy, type: dataSource, created_at: ts 
      });

      // 3. ai_learning (Sirf agar Gemini use hua ya Dr ne edit kiya - for retraining)
      if (dataSource === "gemini" || source === "edited") {
        batch.set(db.collection("ai_learning").doc(), {
          input_text: text, input_symptoms: finalSymptoms, doctor_medicine: medName, pathy: doctor_pathy, timestamp: ts
        });
      }

      // 4. medicine_master & symptoms_keywords (DB Strengthening)
      const masterRef = db.collection("medicine_master").doc(medId);
      batch.set(masterRef, {
        name: m.name, pathy: doctor_pathy, symptoms: admin.firestore.FieldValue.arrayUnion(...finalSymptoms),
        usage_count: admin.firestore.FieldValue.increment(1), 
        verified: dataSource !== "gemini", 
        updated_at: ts
      }, { merge: true });

      finalSymptoms.forEach(sym => {
        const symKey = normalize(sym).replace(/\s+/g, '_');
        batch.set(db.collection("symptoms_keywords").doc(symKey), {
          symptom: sym, 
          keywords_lowercase: admin.firestore.FieldValue.arrayUnion(normalize(sym))
        }, { merge: true });
      });
    });

    await batch.commit();

    // Final response to App
    res.json({ 
      success: true, 
      prescription_id, 
      source: dataSource, 
      diagnosis,
      medicines: finalMedicines,
      symptoms: finalSymptoms 
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 VYONALIFE v2.5: DIRECT-SAVE READY`));
