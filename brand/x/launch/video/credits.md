# Credits: Bellwether launch video

## Music

**"Ice and Snow"** by Rafael Krux, published on FreePD.com (category "Scoring": "Soft, atmospheric and warm cinematic track").

- License: **Creative Commons 0 (CC0)**. FreePD's terms: "100% Free Music - Free for Commercial Use, Free Of Royalties, Free Of Attribution, Creative Commons 0". The track listing adds: "This music is available for commercial and non-commercial purposes." No attribution is required; it is credited here as a courtesy.
- Original URL: https://freepd.com/music/Ice%20and%20Snow.mp3 (FreePD.com closed in 2026; the catalog is preserved by the Internet Archive).
- File used, from the archived copy: https://web.archive.org/web/20251124094312id_/https://freepd.com/music/Ice%20and%20Snow.mp3
- Archived listing: https://web.archive.org/web/20251124094312/https://freepd.com/scoring.php
- Archived license page: https://web.archive.org/web/20251202191130/https://freepd.com/legal.php
- Edit: four sections of the track (0:03–0:28, 0:43–1:02, 1:18–1:33, 2:08–2:21 to the track's own ending), joined with 2 s equal-power crossfades, level-matched and ducked under the voice.

## Voice

Microsoft Edge neural text-to-speech via `edge-tts` 7.2.8, voice **en-US-AndrewMultilingualNeural** (rate +0%, pitch −2 Hz), generated one line at a time and timed to picture. Chosen over en-US-BrianNeural and en-GB-RyanNeural after an audition (widest natural pitch range of the three). Processed with EQ, light compression and a small synthetic room.

## Sound design

All synthesized for this video (numpy): the bell strikes (inharmonic partials at 0.56, 0.92, 1.19, 1.71, 2.00, 2.74, 3.00 and 4.07 of the strike note, each with its own exponential decay and a slow beat, plus a clapper transient, after `apps/web/src/lib/bellSound.ts`), the UI ticks on the number rolls, and the low swell into the end card.

## Picture

- Product footage recorded for this video from the live Bellwether site in headless Chrome (landing page with the bell ringing on an engine event; launch wizard step 3 with the protocol wallet). Figure lines, the site notice and the tape were hidden in the recording, so no dashboard numbers appear.
- Pons create form (Advanced → Creator wallet), cut down from `apps/web/public/media/walkthrough.mp4`, ending before the paste.
- `fork:proof` terminal lines are the real output of `npm run fork:proof -w @bellwether/engine` run on 27 September 2026 (110/110 checks passed in 82 s); check details are trimmed to fit.
- Motion graphics authored in HTML/CSS/SVG with the brand fonts (Newsreader, Geist, Geist Mono) and the engraved bell from `apps/web/src/components/Bell.tsx`, rendered frame by frame in headless Chrome.
