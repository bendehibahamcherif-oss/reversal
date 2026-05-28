export class InferenceService {
  prepareInferenceContext(model, featureRow) {
    return { ready: Boolean(model && featureRow), warnings: ['Inference execution is intentionally disabled in Phase 6C.'] };
  }
}
export const inferenceService = new InferenceService();
