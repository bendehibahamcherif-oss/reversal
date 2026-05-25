import mongoose from 'mongoose';

export async function connectDatabase() {
  if (!process.env.MONGO_URI) {
    console.warn('MongoDB skipped: MONGO_URI is not configured');
    return;
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.warn(`MongoDB unavailable, continuing in degraded mode: ${err.message}`);
  }
}
