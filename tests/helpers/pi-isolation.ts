// Legacy regression tests must never read the developer's Pi credentials or call a subscription.
// Pi integration tests explicitly enable Pi with their own temporary agent directory.
process.env.PI_ENABLED = "0";
