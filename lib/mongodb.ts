import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI ?? "";

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  var mongooseCache: MongooseCache | undefined;
}

const cached: MongooseCache = global.mongooseCache ?? { conn: null, promise: null };
let warnedMissingUri = false;

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

export async function connectToDatabase() {
  if (!MONGODB_URI) {
    if (!warnedMissingUri) {
      console.warn("[mongodb] MONGODB_URI is missing. Serving demo customer data instead.");
      warnedMissingUri = true;
    }
    return null;
  }

  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI);
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (error) {
    cached.promise = null;
    const message = error instanceof Error ? error.message : "Unknown MongoDB connection error.";
    console.warn(`[mongodb] Connection failed. Serving demo customer data instead. ${message}`);
    return null;
  }
}
