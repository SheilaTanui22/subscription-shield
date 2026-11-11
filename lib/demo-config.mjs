// Each demo has its own state file and PayPal idempotency keys. Adding
// MusicBox never replaces the existing StreamBox resources.
export function demoConfiguration(args = []) {
  if (args.some((arg) => arg !== "--musicbox")) {
    throw new Error("Unknown option. Use --musicbox for the second sandbox demo.");
  }
  return args.includes("--musicbox")
    ? { name: "MusicBox", price: "8.00", fileName: "musicbox-demo-state.json", trialDays: 0 }
    : { name: "StreamBox", price: "12.00", fileName: "demo-state.json", trialDays: 7 };
}
