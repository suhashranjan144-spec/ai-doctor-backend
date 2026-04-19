import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* 🔥 FIREBASE INIT */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* 🧠 UTILS */
const normalize = (t) => t?.toLowerCase().trim();
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/* 🧬 MEDICINE TYPE DETECTOR */
function detectType(med) {
  const m = med.toLowerCase();

  if (
    m.includes("paracetamol") ||
    m.includes("ibuprofen") ||
    m.includes("amoxicillin") ||
    m.includes("ors") ||
    m.includes("oral rehydration")
  )
    return "allopathy";

  if (m.includes("belladonna") || m.includes("arnica"))
    return "homeopathy";

  return "unknown";
}

/* 🤖 GEMINI CALLER */
async function callGemini(text, doctor_type) {
  try {
    // ✅ PROMPT (ONLY ONE)
    const prompt = `
You are a SUPER-INTELLIGENT MULTI-PATHY CLINICAL AI.

DOCTOR TYPE RULES:

1. If doctor_type = "allopathy":
- ONLY return allopathy medicines

2. If doctor_type = "homeopathy":
- PRIMARY = homeopathy
- SUGGESTION = allopathy

3. If doctor_type = "ayurveda":
- PRIMARY = ayurveda
- SUGGESTION = allopathy

4. If doctor_type = "electrohomeopathy":
- PRIMARY = electrohomeopathy
- SUGGESTION = allopathy

5. If doctor_type = "unani":
- PRIMARY = unani
- SUGGESTION = allopathy

STRICT:
- Output ONLY valid JSON
- No explanation

FORMAT:
{
  "symptoms": [],
  "diagnosis": "",
  "primary_medicines": [],
  "suggested_medicines": []
}

INPUT: ${text}
DOCTOR TYPE: ${doctor_type}
`;

    // ✅ ONLY ONE FETCH
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      }
    );

    const data = await response.json();

    let txt =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // cleanup
    txt = txt.replace(/```json|```/g, "").trim();

    const parsed = JSON.parse(txt);

// 🔥 AUTO TYPE FIX (NEW ADD)
parsed.primary_medicines =
  (parsed.primary_medicines || []).map(m => ({
    ...m,
    type: m.type || detectType(m.name)
  }));

parsed.suggested_medicines =
  (parsed.suggested_medicines || []).map(m => ({
    ...m,
    type: m.type || detectType(m.name)
  }));

// 🔥 SAFETY FILTER (already hai)
if (doctor_type === "allopathy") {
  parsed.primary_medicines =
    (parsed.primary_medicines || []).filter(
      (m) => (m.type || detectType(m.name)) === "allopathy"
    );

  parsed.suggested_medicines = [];
}
    

    return parsed;
  } catch (err) {
    return {
      diagnosis: "AI error",
      primary_medicines: [],
      suggested_medicines: [],
    };
  }
}

/* 🔥 DB BRAIN */
async function dbBrain(symptoms) {
  let medMap = {};

  for (const sym of symptoms) {
    const normSym = normalize(sym);
    if (!normSym) continue;

    const snap1 = await db
      .collection("doctor_uses")
      .where("symptom", "==", normSym)
      .get();

    snap1.forEach((d) => {
      const data = d.data();
      medMap[data.medicine] =
        (medMap[data.medicine] || 0) + (data.usage_count || 1);
    });

    const snap2 = await db
      .collection("symptoms_keywords")
      .where("symptom", "==", normSym)
      .get();

    snap2.forEach((d) => {
      const data = d.data();
      medMap[data.medicine] =
        (medMap[data.medicine] || 0) + 2;
    });
  }

  let result = [];

  for (let [med, score] of Object.entries(medMap)) {
    const snap = await db
      .collection("medicine_master")
      .where("name", "==", med)
      .limit(1)
      .get();

    let type = snap.empty
      ? detectType(med)
      : snap.docs[0].data().type || detectType(med);

    result.push({ name: med, type, score });
  }

  return result.sort((a, b) => b.score - a.score).slice(0, 5);
}

/* 🧬 CLINICAL ENGINE */
function clinicalEngine(data) {
  const redFlags = [];
  const text = JSON.stringify(data).toLowerCase();

  if (text.includes("chest pain")) redFlags.push("cardiac risk");
  if (text.includes("unconscious")) redFlags.push("emergency");

  const severity =
    redFlags.length > 0 ? "critical" : data.severity || "mild";

  return {
    ...data,
    severity,
    red_flags: [...new Set([...(data.red_flags || []), ...redFlags])],
  };
}

/* 🧹 REMOVE DUPLICATES */
function removeDup(meds = []) {
  const seen = new Set();

  return meds.filter((m) => {
    const raw = typeof m === "string" ? m : m?.name;
    if (!raw) return false;

    const name = normalize(raw).replace(/\(.*?\)/g, "");

    if (!name || seen.has(name)) return false;
    seen.add(name);

    if (typeof m === "object") m.name = name;

    return true;
  });
}

/* 🧠 LEARNING ENGINE */
async function learningEngine(symptoms, medicines) {
  for (const sym of symptoms) {
    const normSym = normalize(sym);
    if (!normSym) continue;

    for (const med of medicines) {
      const normMed = normalize(med);
      if (!normMed) continue;

      await db
        .collection("doctor_uses")
        .doc(`${normSym}_${normMed}`)
        .set(
          {
            symptom: normSym,
            medicine: normMed,
            usage_count: FieldValue.increment(1),
          },
          { merge: true }
        );

      await db
        .collection("symptoms_keywords")
        .doc(`${normSym}_${normMed}`)
        .set(
          {
            symptom: normSym,
            medicine: normMed,
            count: FieldValue.increment(1),
          },
          { merge: true }
        );

      const snap = await db
        .collection("medicine_master")
        .where("name", "==", normMed)
        .limit(1)
        .get();

      if (snap.empty) {
        await db.collection("medicine_master").add({
          name: normMed,
          type: detectType(normMed),
          created_at: new Date(),
        });
      }
    }
  }
}

/* 🚀 ANALYZE */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_type = "allopathy" } = req.body;

    const symptoms = text
      .toLowerCase()
      .split(/,|\s+/)
      .filter((s) => s.length > 3);

    const dbMeds = await dbBrain(symptoms);

    let final;
    let source;

    let filteredMeds = dbMeds;

    if (doctor_type === "allopathy") {
      filteredMeds = dbMeds.filter(
        (m) => (m.type || detectType(m.name)) === "allopathy"
      );
    }

    if (filteredMeds.length === 0) {
      const aiData = await callGemini(text, doctor_type);

      final = {
        ...aiData,
        medicines: [
          ...(aiData.primary_medicines || []),
          ...(aiData.suggested_medicines || [])
        ]
      };

      source = "ai";
    } else {
      const aiData = await callGemini(text, doctor_type);

     final = {
  symptoms,
  diagnosis: "Hybrid result",
  medicines: [
    ...(aiData.primary_medicines || []),   // 👈 MOST IMPORTANT
    ...filteredMeds.map(m => ({
      name: m.name,
      type: m.type,
      source: "db"
    })),
    ...(aiData.suggested_medicines || [])
  ]
};
      source = "hybrid";
    }

    final.medicines = removeDup(final.medicines);
    final = clinicalEngine(final);

    await learningEngine(
      symptoms,
      final.medicines.map((m) => m.name)
    );

    const prescription_id = uuidv4();
    const patient_id = uuidv4();
    const otp = generateOTP();

    await db.collection("prescriptions").doc(prescription_id).set({
      patient_id,
      otp,
      data: final,
      created_at: new Date(),
    });

    const qr = await QRCode.toDataURL(
      JSON.stringify({ patient_id, prescription_id })
    );

    res.json({
      success: true,
      source,
      patient_id,
      prescription_id,
      otp,
      qr,
      data: final,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🔐 VERIFY */
app.post("/verify", async (req, res) => {
  const { prescription_id, otp } = req.body;

  const doc = await db
    .collection("prescriptions")
    .doc(prescription_id)
    .get();

  if (!doc.exists) return res.json({ error: "Not found" });

  const data = doc.data();

  if (data.otp !== otp)
    return res.json({ error: "Invalid OTP" });

  res.json({ success: true, data: data.data });
});

app.get("/", (req, res) =>
  res.send("🔥 ZEQVEX CORE RUNNING")
);

app.listen(3000, () =>
  console.log("🚀 Server running")
);
````
