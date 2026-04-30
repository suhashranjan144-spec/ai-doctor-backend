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

const COLLECTIONS = {
  prescriptions: "prescriptions",
  medicinesMaster: "medicines_master",
  symptomsKeywords: "symptoms_keywords",
  doctorUses: "doctor_uses",
  aiLearningQueue: "ai_learning_queue",
};


// 🔥 MASTER MEDICINE TEMPLATE (👉 YAHI DALNA HAI)
function createMedicineDoc(name, pathy) {
  const norm = name.toLowerCase();

  return {
    name: name,
    name_lowercase: norm,

    pathy: pathy || "unknown",

    category: "general",

    treats: [],
    search_keywords: [norm],

    organ: [],

    combination_with: [],

    common_dose: "",
    default_times: [],
    duration_days: 0,
    frequency: 0,

    severity_support: ["low", "medium"],

    contraindications: [],

    side_effects: [],

    priority_score: 1,

    verified: false,

    created_at: new Date(),
  };
}

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

function toInt(value) {
  if (typeof value === "number") return Math.trunc(value);
  return Number.parseInt(String(value || "").trim(), 10);
}

function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalize(item))
    .filter((item) => !!item);
}

function requiredMissingFields(candidate = {}) {
  const missing = [];
  if (!normalize(candidate.dose)) missing.push("dose");
  if (!normalize(candidate.frequency_unit)) missing.push("frequency_unit");
  if (toStringList(candidate.intake_times).length === 0) {
    missing.push("intake_times");
  }

  const durationDays = toInt(candidate.duration_days);
  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    missing.push("duration_days");
  }

  if (!normalize(candidate.route)) missing.push("route");
  if (!normalize(candidate.food_instruction)) missing.push("food_instruction");

  return missing;
}

function toQueueCandidate(medicine = {}) {
  const medicineName = normalize(medicine.name || medicine.medicine_name || "");
  const candidate = {
    medicine_name: medicineName,
    generic_name: normalize(medicine.generic_name || ""),
    dose: normalize(medicine.dose || medicine.dosage || ""),
    frequency_unit: normalize(medicine.frequency_unit || ""),
    intake_times: toStringList(medicine.intake_times),
    duration_days: toInt(medicine.duration_days || medicine.duration || 0) || 0,
    route: normalize(medicine.route || ""),
    food_instruction: normalize(medicine.food_instruction || ""),
    type: normalize(medicine.type || detectType(medicineName)),
  };

  const missing_required_fields = requiredMissingFields(candidate);
  return {
    ...candidate,
    is_valid: missing_required_fields.length === 0,
    is_incomplete: missing_required_fields.length > 0,
    missing_required_fields,
  };
}

/* 🤖 GEMINI CALLER */
async function callGemini(text, doctor_type, mode = "clinical") {
  try {

const clinicalPrompt = `

You are a highly advanced clinical AI assistant.

Understand patient input in ANY language (Hindi, Gujarati, Marathi, Hinglish, etc.) but respond in PROFESSIONAL MEDICAL ENGLISH.

-------------------------------
⚠️ STRICT SYSTEM RULES
-------------------------------
- Output ONLY VALID JSON
- No explanation, no extra text
- DO NOT change structure
- DO NOT skip fields
- DO NOT return null values
- Always fill arrays (even if empty [])

-------------------------------
🧠 CLINICAL BEHAVIOR RULES
-------------------------------
- Extract clear, short symptoms (1–2 words)
- Provide realistic diagnosis (not random)
- Prefer clinically safe suggestions
- Avoid unnecessary medicines
- Add precautions if risk present

-------------------------------
💊 DOCTOR TYPE RULES
-------------------------------
1. allopathy:
   - Only allopathy medicines

2. homeopathy:
   - Prefer homeopathy
   - Allopathy allowed as secondary

3. ayurveda:
   - Prefer ayurveda
   - Allopathy allowed as secondary

4. electrohomeopathy:
   - STRICT electrohomeopathy medicines (S, WE, C, etc.)
   - Allopathy allowed as secondary

5. unani:
   - Prefer unani
   - Allopathy allowed as secondary

-------------------------------
📦 OUTPUT FORMAT (STRICT JSON)
-------------------------------
{
  "language_detected": "",
  "symptoms": [],
  "diagnosis": "",
  "possible_conditions": [],

  "primary_medicines": [
    {
      "name": "",
      "type": "",
      "dosage": "",
      "duration": "",
      "instructions": ""
    }
  ],

  "suggested_medicines": [
    {
      "name": "",
      "type": "",
      "dosage": "",
      "duration": "",
      "instructions": ""
    }
  ],

  "diet": [],
  "exercise": [],
  "precautions": [],
  "severity": "mild/moderate/critical",
  "risks": [],
  "red_flags": []
}

-------------------------------
📥 INPUT
-------------------------------
INPUT: ${text}
DOCTOR TYPE: ${doctor_type}

`;

const prompt = mode === "patient" ? patientPrompt : clinicalPrompt;

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
const symptomCount = symptoms.length;

  for (const sym of symptoms) {
    const normSym = normalize(sym);
    if (!normSym) continue;

    const snap1 = await db
      .collection(COLLECTIONS.doctorUses)
      .where("symptom", "==", normSym)
      .get();

   snap1.forEach((d) => {
  const data = d.data();

  const now = Date.now();
  const lastUsed = data.last_used?.toDate()?.getTime() || 0;

  const recencyBoost =
    (now - lastUsed) < 3 * 24 * 60 * 60 * 1000 ? 2 : 1;

  medMap[data.medicine] =
    (medMap[data.medicine] || 0) +
    (data.usage_count || 1) * 3 * recencyBoost * symptomCount;
});
    const snap2 = await db
      .collection(COLLECTIONS.symptomsKeywords)
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
      .collection(COLLECTIONS.medicinesMaster)
     .doc(med)
     .get();

   let type = snap.exists
     ? snap.data().pathy || detectType(med)
     : detectType(med);

    result.push({
  name: med,
  type,
  score,
  pathy: type,
confidence: Math.min(1, score / 10)
});
  }

  return result.sort((a, b) => b.score - a.score).slice(0, 5);
}

/* 🧬 CLINICAL ENGINE */
function detectDisease(symptoms) {
  const s = symptoms.join(" ");

  if (s.includes("fever") && s.includes("cough"))
    return "viral infection";

  if (s.includes("loose motion") || s.includes("diarrhea"))
    return "gastroenteritis";

  if (s.includes("worms") || s.includes("itching anus"))
    return "worm infestation";

  return "unknown";
}
function getComboMedicines(disease) {
  const map = {
    "viral infection": ["paracetamol", "ors"],
    "gastroenteritis": ["ors", "metronidazole"],
    "worm infestation": ["vermifugo-1", "we"],
  };

  return map[disease] || [];
}

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
  // Legacy path disabled: direct master writes are blocked by policy.
  throw new Error("Legacy learningEngine is disabled. Use learningQueueEngine.");

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
            last_used: new Date(),
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

        await db
  .collection("medicines_master")
  .doc(normMed)
  .set({
    search_keywords: FieldValue.arrayUnion(normSym, normMed)
  }, { merge: true });


      const snap = await db
        .collection("medicines_master")
        .doc(normMed)
        .get();

       const isTrustedSource = true;
       if (!snap.exists && isTrustedSource) {
  const pathy = detectType(normMed);

  const newMed = createMedicineDoc(normMed, pathy);

  await db
    .collection("medicines_master")
    .doc(normMed)
    .set(newMed, { merge: true });
}
    }
  }
}

/* 🚀 ANALYZE */
async function learningQueueEngine({
  symptoms = [],
  medicines = [],
  doctorId = "unknown_doctor",
  doctorType = "allopathy",
  rawText = "",
  prescriptionId = "",
}) {
  const batch = db.batch();

  for (const sym of symptoms) {
    const normSym = normalize(sym);
    if (!normSym) continue;

    for (const med of medicines) {
      const medicineObject =
        typeof med === "string" ? { name: med } : med || {};
      const queueCandidate = toQueueCandidate(medicineObject);
      const normMed = normalize(queueCandidate.medicine_name);
      if (!normMed) continue;

      const queueDocId = `${normalize(doctorId) || "unknown"}_${normSym}_${normMed}`;
      const queueRef = db.collection(COLLECTIONS.aiLearningQueue).doc(queueDocId);

      batch.set(
        queueRef,
        {
          doctor_id: doctorId || "unknown_doctor",
          doctor_pathy: doctorType,
          symptom: normSym,
          medicine: normMed,
          symptoms: [normSym],
          raw_text: rawText || "",
          prescription_id: prescriptionId || "",
          candidate_payload: queueCandidate,
          missing_required_fields: queueCandidate.missing_required_fields,
          is_valid: false,
          is_incomplete: true,
          review_required: true,
          schema_version: 1,
          status: "pending_review",
          source: "backend_fallback_guard",
          queue_hits: FieldValue.increment(1),
          last_seen_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
          created_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }

  await batch.commit();
}

app.post("/analyze", async (req, res) => {
  try {
    const {
      text,
      doctor_type = "allopathy",
      doctor_id = "unknown_doctor",
      patient_id: requestedPatientId = "",
    } = req.body;

    const symptoms = text
      .toLowerCase()
      .split(/,|\s+/)
      .filter((s) => s.length > 3);

    const dbMeds = await dbBrain(symptoms);
    const disease = detectDisease(symptoms);
    const comboMeds = getComboMedicines(disease);

    let final;
    let source;

    let filteredMeds = dbMeds;

    if (doctor_type === "allopathy") {
      filteredMeds = dbMeds.filter(
        (m) => (m.type || detectType(m.name)) === "allopathy"
      );
    }

    // 🔥 AI ONLY CASE
    if (filteredMeds.length === 0) {
      const aiData = await callGemini(text, doctor_type);

      const dbNames = new Set(
  filteredMeds.map(m => normalize(m.name))
);// ⚠️ FIXED

      final = {
  symptoms: aiData.symptoms || symptoms,
  diagnosis: aiData.diagnosis || "AI result",
  disease,
  combo_medicines: comboMeds,
  ...aiData,
  medicines: [
    ...(aiData.primary_medicines || []),
    ...(aiData.suggested_medicines || [])
  ]
};
      source = "ai";
    }

    // 🔥 HYBRID CASE
    else {
      const aiData = await callGemini(text, doctor_type);

      final = {
        symptoms,
        diagnosis: aiData.diagnosis || "Hybrid result",
        disease,
        combo_medicines: comboMeds,
        medicines: [
          ...(aiData.primary_medicines || []),
          ...filteredMeds.map((m) => ({
            name: m.name,
            type: m.type,
            source: "db",
          })),
          ...(aiData.suggested_medicines || []),
        ],
      };

      source = "hybrid";
    }

    final.medicines = removeDup(final.medicines);
    final = clinicalEngine(final);

    const prescription_id = uuidv4();
    const patient_id = requestedPatientId || uuidv4();
    const otp = generateOTP();

    await db.collection(COLLECTIONS.prescriptions).doc(prescription_id).set({
      patient_id,
      doctor_id,
      otp,
      data: final,
      created_at: new Date(),
    });

    await learningQueueEngine({
      symptoms,
      medicines: final.medicines,
      doctorId: doctor_id,
      doctorType: doctor_type,
      rawText: text,
      prescriptionId: prescription_id,
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
app.post("/queue/review", async (req, res) => {
  try {
    const { queue_id, decision, reviewer_id = "unknown_reviewer" } = req.body;

    if (!queue_id || !decision) {
      return res.status(400).json({
        success: false,
        error: "queue_id and decision are required",
      });
    }

    const queueRef = db.collection(COLLECTIONS.aiLearningQueue).doc(queue_id);
    const queueDoc = await queueRef.get();

    if (!queueDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "Queue item not found",
      });
    }

    const queueData = queueDoc.data() || {};
    if (queueData.status !== "pending_review") {
      return res.status(400).json({
        success: false,
        error: "Queue item is not pending review",
      });
    }

    if (decision === "reject") {
      await queueRef.update({
        status: "rejected",
        reviewed_by: reviewer_id,
        reviewed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.json({ success: true, status: "rejected" });
    }

    if (decision !== "approve") {
      return res.status(400).json({
        success: false,
        error: "decision must be approve or reject",
      });
    }

    const candidate = queueData.candidate_payload || {};
    const medicineName = normalize(candidate.medicine_name || queueData.medicine || "");
    if (!medicineName) {
      return res.status(400).json({
        success: false,
        error: "medicine_name missing in queue candidate",
      });
    }

    const missing = requiredMissingFields(candidate);
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Cannot approve incomplete candidate",
        missing_required_fields: missing,
      });
    }

    const symptomList = Array.isArray(queueData.symptoms)
      ? queueData.symptoms.map((s) => normalize(s)).filter(Boolean)
      : [normalize(queueData.symptom)].filter(Boolean);

    const batch = db.batch();

    const masterRef = db.collection(COLLECTIONS.medicinesMaster).doc(medicineName);
    batch.set(
      masterRef,
      {
        medicine_name: medicineName,
        name: medicineName,
        generic_name: normalize(candidate.generic_name || ""),
        dose: normalize(candidate.dose || ""),
        standard_dose: normalize(candidate.dose || ""),
        frequency_unit: normalize(candidate.frequency_unit || ""),
        intake_times: toStringList(candidate.intake_times),
        duration_days: toInt(candidate.duration_days) || 0,
        route: normalize(candidate.route || ""),
        food_instruction: normalize(candidate.food_instruction || ""),
        pathy: normalize(candidate.type || queueData.doctor_pathy || "unknown"),
        verified: false,
        source: "ai_learning_queue_approved",
        updated_at: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    for (const symptom of symptomList) {
      const keywordRef = db
        .collection(COLLECTIONS.symptomsKeywords)
        .doc(`${symptom}_${medicineName}`);
      batch.set(
        keywordRef,
        {
          symptom,
          medicine: medicineName,
          count: FieldValue.increment(1),
          updated_at: FieldValue.serverTimestamp(),
          created_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const doctorId = normalize(queueData.doctor_id || "");
      if (doctorId) {
        const doctorUseRef = db
          .collection(COLLECTIONS.doctorUses)
          .doc(`${doctorId}_${symptom}_${medicineName}`);
        batch.set(
          doctorUseRef,
          {
            doctor_id: doctorId,
            doctor_pathy: queueData.doctor_pathy || "unknown",
            symptom,
            medicine: medicineName,
            usage_count: FieldValue.increment(1),
            last_used: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
            created_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    batch.update(queueRef, {
      status: "approved",
      reviewed_by: reviewer_id,
      reviewed_at: FieldValue.serverTimestamp(),
      promoted_to_master: true,
      updated_at: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return res.json({
      success: true,
      status: "approved",
      medicine: medicineName,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/verify", async (req, res) => {
  const { prescription_id, otp } = req.body;

  const doc = await db
    .collection(COLLECTIONS.prescriptions)
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
