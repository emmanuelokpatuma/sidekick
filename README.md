# Sidekick

A browser-based interview practice assistant using Gemini. Audio from the
microphone goes directly from the browser to Gemini; the serverless endpoints
check the key, create a short-lived audio token, and generate explanatory answers.
Without a connected key, demo mode uses locally generated sample notes. Other
questions require Gemini; if it is unavailable the app shows an error rather
than presenting sample stories as answers. Replace the prefilled example
stories with your own experience.

## Deploy

Import this repository into Vercel or Netlify. No framework preset is needed.
Vercel uses `vercel.json`; Netlify uses `netlify.toml` to build the static
files and route API requests to its functions. Use the platform's HTTPS URL
to allow microphone access.

Paste your own Gemini API key into the page and select **Connect**. The browser
remembers it locally and sends it to the app's endpoints to make Gemini API
requests. Do not commit keys or `.env` files.

You can optionally configure `GEMINI_API_KEY` as an environment variable in
your hosting provider, but anyone who can access a public deployment can use
that key's quota through the app. For a public site, leaving it unset and
using your own key in the browser is safer.

## Check locally

Run `npm test` for endpoint adapter tests and `npm run build:netlify` to
generate the Netlify static site in `dist`. The project has no standalone
local server; API requests require a hosting platform or its local emulator.
