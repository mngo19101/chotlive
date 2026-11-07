const FAKE = new URL('./connector.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'tiktok-live-connector') return { url: FAKE, shortCircuit: true };
  return nextResolve(specifier, context);
}
