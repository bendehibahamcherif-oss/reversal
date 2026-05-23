import mongoose from 'mongoose';

const ExecutionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    symbol: String,
    side: String,
    quantity: Number,
    fillPrice: Number,
    slippage: Number,
    status: String,
  },
  {
    timestamps: true,
  }
);

export default mongoose.model(
  'Execution',
  ExecutionSchema
);
