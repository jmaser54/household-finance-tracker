// The oldest JavaScript engine the app must run in: macOS Monterey's built-in
// WebKit (Safari 15 generation), which is what the app's window uses there,
// not the newer engine a Safari app update brings. Used by vite.config.ts to
// compile down to it and by check-engine-syntax.mjs to verify the build.
export const ENGINE_FLOOR = 'safari15';
