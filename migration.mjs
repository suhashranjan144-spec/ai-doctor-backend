import admin from "firebase-admin";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

/* 🔥 FIREBASE INIT (FILE READ METHOD) */
const serviceAccount = JSON.parse(
  fs.readFileSync("./firebase-key.json", "utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* 🔧 DEFAULT STRUCTURE */
function fixMedicineDoc(data) {
  return {
    medicine_name: data.medicine_name || "",
    generic_name: data.generic_name || "",
    pathy: data.pathy || "Allopathy",

    dose: Array.isArray(data.dose) ? data.dose : [],
    frequency: data.frequency || 1,
    frequency_unit: data.frequency_unit || "day",

    duration_days: data.duration_days || 1,
    route: data.route || "ORAL",
    food_instruction: data.food_instruction || "after_food",

    intake_times: Array.isArray(data.intake_times) ? data.intake_times : [],
    strength: data.strength || "",
    strength_unit: data.strength_unit || "mg",

    is_active: data.is_active ?? true,

    created_at: data.created_at || new Date(),
    updated_at: new Date(),
  };
}

/* 🚀 MIGRATION RUNNER */
async function migrateMedicines() {
  const snapshot = await db.collection("medicines").get();

  console.log(`Total docs: ${snapshot.size}`);

  for (const doc of snapshot.docs) {
    const data = doc.data();

    const fixedData = fixMedicineDoc(data);

    await doc.ref.update(fixedData);

    console.log(`✅ Fixed: ${doc.id}`);
  }

  console.log("🔥 Migration Complete");
}

/* ▶️ RUN */
migrateMedicines().then(() => process.exit());