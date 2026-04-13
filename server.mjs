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
const MODEL = "gemini-2.5-flash";

const normalize = (t) => t?.toLowerCase().trim();
const localCache = new Map();

/* 🔥 SAFE JSON */
function safeJSON(txt) {
  try {
    if (!txt) throw new Error("Empty");

    let clean = txt.replace(/```json/g, "").replace(/```/g, "").trim();

    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");

    if (start !== -1 && end !== -1) {
      return JSON.parse(clean.substring(start, end + 1));
    }

    throw new Error("No JSON");
  } catch {
    return {
      symptoms: ["Analysis Failed"],
      diagnosis: "Server Busy - Try Again",
      medicines: [],
      diet: [],
      exercise: [],
      precautions: []
    };
  }
}

/* 🔥 PROMPT */
const MASTER_PROMPT = `
Act as a world-class diagnostic expert.

Understand any Indian language.
Output MUST be English.
Return STRICT JSON only.

{
  "symptoms": [],
  "diagnosis": "",
  "medicines": [],
  "diet": [],
  "exercise": [],
  "precautions": []
}
`;

/* 🔥 ULTRA FIXED GEMINI */
async function callGemini(text, pathy) {
  const prompt = `Pathy: ${pathy}\nPatient: ${text}\n${MASTER_PROMPT}`;

  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }]
          })
        }
      );

      const data = await res.json();

      // 🔥 HANDLE 503
      if (data?.error?.code === 503) {
        console.warn(`⏳ Retry ${i} - Gemini busy`);
        await new Promise(r => setTimeout(r, 1000 * i));
        continue;
      }

      let txt = "";
      if (data?.candidates?.length) {
        for (const p of data.candidates[0].content.parts || []) {
          if (p.text) txt += p.text;
        }
      }

      if (!txt) {
        console.error("❌ EMPTY RESPONSE:", data);
        continue;
      }

      return safeJSON(txt);

    } catch (e) {
      console.error(`❌ Retry ${i} failed`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 🔥 FINAL SAFE RETURN
  return {
    symptoms: ["Server Busy"],
    diagnosis: "High traffic on AI server",
    medicines: [],
    diet: [],
    exercise: [],
    precautions: []
  };
}

/* 🔥 बाकी code SAME है (touch नहीं किया) */

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
