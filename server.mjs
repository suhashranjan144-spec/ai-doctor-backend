import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* 🔥 FIREBASE INIT */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

/* 🔑 GEMINI CONFIG */
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

const normalize = (t) => t?.toLowerCase().trim();

/* 🔍 DB SEARCH (Fallback Logic) */
async function searchDoctorUsage(symptoms, pathy) {
    let meds = [];
    for (const sym of symptoms) {
        const snap = await db.collection("doctor_uses")
            .where("symptom", "==", normalize(sym))
            .where("doctor_pathy", "==", pathy)
            .orderBy("usage_count", "desc")
            .limit(3).get();

        snap.forEach((doc) => meds.push(doc.data().medicine_name));
    }
    return [...new Set(meds)];
}

/* 💾 SMART UPDATE (Repairing doctor_uses) */
async function updateDoctorUsage(doctor_id, pathy, symptoms, medicines) {
    const batch = db.batch(); // Batch use kar rahe hain speed ke liye
    for (const sym of symptoms) {
        for (const med of medicines) {
            // Unique ID banayi taaki duplicate docs na banein
            const comboId = Buffer.from(`${normalize(sym)}_${normalize(med)}_${pathy}`).toString('base64').substring(0, 20);
            const docRef = db.collection("doctor_uses").doc(comboId);

            batch.set(docRef, {
                doctor_id,
                doctor_pathy: pathy,
                symptom: normalize(sym),
                medicine_name: normalize(med),
                usage_count: admin.firestore.FieldValue.increment(1),
                last_used: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
    }
    await batch.commit();
}

/* 🚀 ANALYZE API */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id = "default_doc", doctor_pathy = "Allopathy" } = req.body;
        if (!text) return res.status(400).json({ error: "Text required" });

        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

        // 🔥 PROMPT UPDATED: Ab sab kuch English mein aayega (Global Standard)
        const prompt = `You are a professional ${doctor_pathy} clinical assistant. 
        Task: Analyze the patient's text and provide a structured medical summary.
        Text: "${text}"
        
        STRICT RULES:
        1. All output must be in ENGLISH only.
        2. Symptoms must be clinical keywords.
        3. Medicines must follow ${doctor_pathy} pathy.
        4. Diet and Exercise should be professional and specific.
        5. Return ONLY JSON.
        
        JSON Format:
        {"symptoms":[], "medicines":[], "diet":[], "exercise":[], "precautions":[]}`;

        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3 } // Lower temperature for more accuracy
            }),
        });

        const data = await response.json();
        let aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        aiText = aiText.replace(/```json|```/g, "").trim();
        const aiResponse = JSON.parse(aiText);

        // 🔍 Check DB Fallback
        const dbMeds = await searchDoctorUsage(aiResponse.symptoms, doctor_pathy);
        let finalMedicines = dbMeds.length > 0 ? dbMeds : aiResponse.medicines;

        // 🔥 UPDATE DOCTOR_USES
        await updateDoctorUsage(doctor_id, doctor_pathy, aiResponse.symptoms, finalMedicines);

        // 🧠 DEEP LEARNING COLLECTION (For Future AI Training)
        await db.collection("ai_learning").add({
            doctor_id,
            doctor_pathy,
            input_text: text, // Raw patient input
            structured_data: aiResponse, // JSON data from AI
            final_medicines: finalMedicines,
            engine_used: dbMeds.length > 0 ? "database" : "ai",
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({
            ...aiResponse,
            medicines: finalMedicines,
            engine: dbMeds.length > 0 ? "database" : "ai"
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Zeqvex Engine Global Live"));
