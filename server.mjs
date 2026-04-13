import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors(), express.json({ limit: "50mb" }));

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
const MODEL = "gemini-1.5-flash"; // ✅ FIXED MODEL

const normalize = (t) => t?.toLowerCase().trim();
const localCache = new Map();

/* 🔥 SAFE JSON PARSER */
function safeJSON(txt) {
  try {
    if (!txt) throw new Error("Empty response");

    let clean = txt.replace(/```json/g, "").replace(/```/g, "").trim();

    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");

    if (start !== -1 && end !== -1) {
      clean = clean.substring(start, end + 1);
      return JSON.parse(clean);
    }

    throw new Error("No JSON found");
  } catch (e) {
    console.error("❌ JSON Parsing failed:", txt);
    return {
      symptoms: ["Analysis Error"],
      diagnosis: "Formatting Issue",
      medicines: [],
      diet: [],
      exercise: [],
      precautions: [],
    };
  }
}

/* 🔥 MASTER PROMPT */
const MASTER_PROMPT = `
Act as a world-class diagnostic expert.

1. Support all languages. Output MUST be English.
2. Electrohomeopathy only if pathy matches (S1, F1, etc)
3. Otherwise normal medicines
4. RETURN ONLY PURE JSON

{
  "symptoms": [],
  "diagnosis": "",
  "medicines": [],
  "diet": [],
  "exercise": [],
  "precautions": []
}
`;

/* 🔥 GEMINI FIXED CALL */
async function callGemini(text, pathy) {
  try {
    const prompt = `Pathy: ${pathy}\nPatient: ${text}\n${MASTER_PROMPT}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
        }),
      }
    );

    const data = await res.json();

    const txt =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ||
      "";

    if (!txt) {
      console.error("❌ Gemini EMPTY RESPONSE:", data);
      return safeJSON("");
    }

    return safeJSON(txt);
  } catch (e) {
    console.error("❌ Gemini Error:", e.message);
    return safeJSON("");
  }
}

/* 🔥 SYMPTOMS MAP */
async function mapSymptoms(input) {
  input = input.toLowerCase();
  const result = new Set();

  const snap = await db.collection("symptoms_keywords").get();
  snap.forEach((doc) => {
    const d = doc.data();
    (d.keywords_lowercase || []).forEach((k) => {
      if (input.includes(k)) result.add(d.symptom);
    });
  });

  return [...result];
}

/* 🔥 DB SEARCH */
async function getFromDB(symptoms, pathy) {
  const map = new Map();
  if (symptoms.length === 0) return [];

  for (const sym of symptoms) {
    const snap = await db
      .collection("medicine_master")
      .where("pathy", "==", pathy)
      .where("symptoms", "array-contains", sym)
      .get();

    snap.forEach((d) => map.set(d.id, d.data()));
  }

  return [...map.values()];
}

/* 🔥 ANALYZE */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_pathy = "allopathy" } = req.body;

    const cacheKey = `${doctor_pathy}_${text.slice(0, 30)}`;
    if (localCache.has(cacheKey))
      return res.json(localCache.get(cacheKey));

    let symptoms = await mapSymptoms(text);
    let dbMeds = await getFromDB(symptoms, doctor_pathy);

    let finalData;

    if (dbMeds.length >= 3) {
      finalData = {
        symptoms,
        diagnosis: "Verified via records",
        medicines: dbMeds,
        diet: ["Follow protocol"],
        exercise: ["As advised"],
        precautions: ["Standard precautions"],
        source: "local_db",
      };
    } else {
      const ai = await callGemini(text, doctor_pathy);
      finalData = { ...ai, source: "gemini" };
    }

    finalData.prescription_id =
      db.collection("prescriptions").doc().id;

    localCache.set(cacheKey, finalData);

    res.json(finalData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🔥 SAVE */
app.post("/save-prescription", async (req, res) => {
  try {
    const {
      prescription_id,
      doctor_id,
      patient_id,
      doctor_pathy,
      medicines,
      symptoms,
      source,
    } = req.body;

    if (!prescription_id)
      return res.status(400).json({ error: "missing id" });

    await db.collection("prescriptions").doc(prescription_id).set({
      doctor_id,
      patient_id,
      doctor_pathy,
      medicines,
      symptoms,
      source,
      created_at: new Date(),
    });

    const batch = db.batch();

    medicines.forEach((m) => {
      const name = normalize(m.name);

      batch.set(db.collection("doctor_uses").doc(), {
        doctor_id,
        medicine_name: name,
        symptoms,
        doctor_pathy,
        type: source,
        created_at: new Date(),
      });
    });

    await batch.commit();

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🔥 SERVER */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 SERVER RUNNING ON ${PORT}`)
);
