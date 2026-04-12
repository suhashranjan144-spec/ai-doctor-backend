import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";

dotenv.config();
const app = express();
app.use(cors(), express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";
const normalize = (t) => t?.toLowerCase().trim();

/* 🔍 SYMPTOM BUILDER (With Random Document ID) */
async function syncSymptomKeywords(clinicalTerm, rawText) {
    const snap = await db.collection("symptoms_keywords")
        .where("clinical_term", "==", clinicalTerm).get();

    if (snap.empty) {
        // ✅ Wapas .add() use kar rahe hain random ID ke liye
        await db.collection("symptoms_keywords").add({
            clinical_term: clinicalTerm,
            keywords: [normalize(clinicalTerm)],
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        });
    }
}

/* 🚀 ANALYZE API (With Strong Fallback) */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id = "default_doc", doctor_pathy = "Allopathy" } = req.body;
        if (!text) return res.status(400).json({ error: "No text" });

        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
        const prompt = `Analyze: "${text}". Pathy: ${doctor_pathy}. Return JSON: {"symptoms":[], "medicines":[], "diet":[], "exercise":[], "precautions":[]}. English only. Medicines must be specific to ${doctor_pathy}.`;

        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.4 }
            }),
        });

        const data = await response.json();
        const aiResponse = JSON.parse(data.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim());

        // 1. Sync Symptoms
        for (let sym of aiResponse.symptoms) { await syncSymptomKeywords(sym, text); }

        // 2. Medicine Enrichment with FALLBACK
        let detailedMeds = [];
        for (let medName of aiResponse.medicines) {
            const vipSnap = await db.collection("medicines_master")
                .where("name_lowercase", "==", normalize(medName))
                .where("pathy", "==", doctor_pathy).limit(1).get();

            if (!vipSnap.empty) {
                const vip = vipSnap.docs[0].data();
                detailedMeds.push({
                    name: medName,
                    potency: vip.potency ? vip.potency[0] : "Q",
                    dosage: vip.common_dose || "As directed",
                    is_verified: true
                });
            } else {
                // ✅ FALLBACK: Agar DB mein nahi hai, toh AI ki suggestion dikhao
                detailedMeds.push({
                    name: medName,
                    potency: "Consult Dr",
                    dosage: "As directed",
                    is_verified: false
                });
            }
        }

        // 💾 AI Learning update
        await db.collection("ai_learning").add({
            doctor_id, doctor_pathy, input_text: text,
            structured_data: aiResponse,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            ...aiResponse,
            medicines: detailedMeds,
            engine: "ai_hybrid"
        });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Server Live"));
