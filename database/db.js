import mongoose from 'mongoose';

export async function connectDatabase() {
  try {
    await mongoose.connect(
      process.env.MONGO_URI,
      {
        autoIndex: true,
      }
    );

    console.log('Database connected');
  } catch (err) {
    console.error(err);

    process.exit(1);
  }
}
