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

/* 🔍 DB SEARCH (Pehle DB se dhoondo - Fallback Logic) */
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

/* 💾 SMART UPDATE (Aadhe-adhure fields fill karne ke liye) */
async function updateDoctorUsage(doctor_id, pathy, symptoms, medicines) {
    for (const sym of symptoms) {
        for (const med of medicines) {
            const snap = await db.collection("doctor_uses")
                .where("doctor_id", "==", doctor_id)
                .where("symptom", "==", normalize(sym))
                .where("medicine_name", "==", normalize(med))
                .get();

            if (!snap.empty) {
                // Purane docs mein missing fields yahan update honge
                await snap.docs[0].ref.update({
                    usage_count: admin.firestore.FieldValue.increment(1),
                    doctor_pathy: pathy, 
                    last_used: new Date(),
                });
            } else {
                // Naya doc saare fields ke saath
                await db.collection("doctor_uses").add({
                    doctor_id,
                    doctor_pathy: pathy,
                    symptom: normalize(sym),
                    medicine_name: normalize(med),
                    usage_count: 1,
                    created_at: new Date(),
                    last_used: new Date(),
                });
            }
        }
    }
}

/* 🚀 ANALYZE API */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id = "default_doc", doctor_pathy = "Allopathy" } = req.body;
        if (!text) return res.status(400).json({ error: "Text required" });

        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

        // Prompt mein Local Language aur Pathy dono set kar diye hain
        const prompt = `You are an expert ${doctor_pathy} assistant. Analyze: "${text}". Extract symptoms in English. Medicines must be ${doctor_pathy}. Diet/Exercise must be in the patient's local language style. Return STRICT JSON: {"symptoms":[], "medicines":[], "diet":[], "exercise":[], "precautions":[]}`;

        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.4 }
            }),
        });

        const data = await response.json();
        let aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        aiText = aiText.replace(/```json|```/g, "").trim();
        const aiResponse = JSON.parse(aiText);

        // 🔍 Check Database First (Fallback)
        const dbMeds = await searchDoctorUsage(aiResponse.symptoms, doctor_pathy);
        let finalMedicines = dbMeds.length > 0 ? dbMeds : aiResponse.medicines;

        // 🔥 Learning + Database Repairing
        await updateDoctorUsage(doctor_id, doctor_pathy, aiResponse.symptoms, finalMedicines);

        // Global learning collection
        await db.collection("ai_learning").add({
            doctor_id,
            doctor_pathy,
            text,
            extracted: aiResponse,
            timestamp: new Date()
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

app.listen(process.env.PORT || 3000, () => console.log("🔥 Zeqvex Engine Live"));
