import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

const normalize = (t) => t?.toLowerCase().trim();

/* 🔍 SYMPTOM MAPPING: Link local language to clinical terms */
async function syncSymptomKeywords(clinicalTerm, rawText) {
    const symptomRef = db.collection("symptoms_keywords").doc(normalize(clinicalTerm));
    const doc = await symptomRef.get();

    if (!doc.exists) {
        // Naya Symptom dhang se save karo
        await symptomRef.set({
            clinical_term: clinicalTerm,
            keywords: [normalize(clinicalTerm)], 
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        });
    }
}

/* 🔍 DB SEARCH: Doctor's experience */
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

/* 💎 VIP LOOKUP: Get full details */
async function getMedicineVipDetails(medicineName, pathy) {
    const snap = await db.collection("medicines_master")
        .where("name_lowercase", "==", normalize(medicineName))
        .where("pathy", "==", pathy)
        .limit(1).get();

    if (!snap.empty) {
        return snap.docs[0].data();
    }
    return null;
}

/* 💾 SMART UPDATE */
async function updateDoctorUsage(doctor_id, pathy, symptoms, medicines) {
    const batch = db.batch();
    for (const sym of symptoms) {
        for (const med of medicines) {
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

/* 🚀 ANALYZE API (Full System Sync) */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id = "default_doc", doctor_pathy = "Allopathy" } = req.body;
        if (!text) return res.status(400).json({ error: "Text required" });

        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

        // Prompt modified to ensure clinical accuracy
        const prompt = `Analyze: "${text}". Pathy: ${doctor_pathy}. Return JSON: {"symptoms":[], "medicines":[], "diet":[], "exercise":[], "precautions":[]}. All English.`;

        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3 }
            }),
        });

        const data = await response.json();
        let aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const aiResponse = JSON.parse(aiText.replace(/```json|```/g, "").trim());

        // 🔗 Step 1: Auto-rebuild symptoms_keywords
        for (let sym of aiResponse.symptoms) {
            await syncSymptomKeywords(sym, text);
        }

        // 🔍 Step 2: Check Experience
        const dbMeds = await searchDoctorUsage(aiResponse.symptoms, doctor_pathy);
        let finalMedNames = dbMeds.length > 0 ? dbMeds : aiResponse.medicines;

        // 💎 Step 3: Enrichment from medicines_master
        let medicinesWithDetails = [];
        for (let medName of finalMedNames) {
            const vipData = await getMedicineVipDetails(medName, doctor_pathy);
            if (vipData) {
                medicinesWithDetails.push({
                    name: medName,
                    potency: vipData.potency ? vipData.potency[0] : "Q",
                    dosage: vipData.common_dose || "As directed",
                    organ: vipData.organ || "General",
                    is_verified: true
                });
            } else {
                medicinesWithDetails.push({ name: medName, is_verified: false });
            }
        }

        // 💾 Step 4: Learning
        await updateDoctorUsage(doctor_id, doctor_pathy, aiResponse.symptoms, finalMedNames);
        await db.collection("ai_learning").add({
            doctor_id, doctor_pathy, input_text: text, 
            structured_data: aiResponse, 
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({
            ...aiResponse,
            medicines: medicinesWithDetails,
            engine: dbMeds.length > 0 ? "database" : "ai"
        });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Zeqvex VIP Auto-Sync Engine Live"));
