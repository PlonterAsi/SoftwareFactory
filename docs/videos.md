# Videos: watch and learn

SoftwareFactory can watch a video and keep what it learned. Give it a YouTube link, or a video file you saved, and
an optional question. Gemini watches the picture and the sound and answers with timestamped notes. The notes are kept
in the database with a full-text index, so a video is learned once and found again by search.

## Where it is

- **Systems, Videos**: paste the Gemini key, set the daily limit, watch a link or a file, read and search the notes.
- **Add-ons** with the `video` permission (Scout) call `sf.video.watch` and `sf.video.search` ([plugins.md](plugins.md)).
- **API**: `GET /api/videos`, `POST /api/videos/key`, `POST /api/videos/settings`, `POST /api/videos/watch`,
  `GET /api/videos/notes?q=`, `GET /api/videos/notes/:id`.

## The key

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). It is saved in
`~/.config/watch/.env` as `GEMINI_API_KEY`, the same file Claude Code's `/watch` plugin
([bradautomates/claude-video](https://github.com/bradautomates/claude-video)) reads, so one paste serves both.
A `GEMINI_API_KEY` in the environment wins over the file. The key is never logged and never sent back to a screen.

The free tier needs no card. It takes YouTube links (up to 8 hours of YouTube a day) and allows roughly 20 requests a day
on Gemini 3.8 Flash and a few hundred on Flash-Lite. SoftwareFactory tries 3.8 Flash first and moves to Flash-Lite
when the free allowance runs out. Google may use free-tier requests to improve its products and people may read them,
so send only public videos and clips you are fine sharing. A Google AI Pro plan includes $10 a month of Gemini API
credit, claimed in AI Studio after a $5 prepayment; with it the key is on the paid tier, where requests are not used.

## Cost

Gemini samples one frame a second plus the sound, about 100 tokens a second at low resolution: a 10-minute video is
about 60,000 tokens. On the free tier that costs nothing. Each note shows what it would cost on a paid key (about $0.05
for 10 minutes on Gemini 3.8 Flash at its price until 31 December 2026, double from 1 January 2027). A daily limit,
40 videos by default, stops a loop from watching without end. Asking the same question of the same video again is
answered from the notes and costs nothing; ask to refresh to watch again.

## What is fetched

Only YouTube links, and only by Google: nothing is downloaded on this computer, which keeps within YouTube's terms.
Public videos only (not private or unlisted). TikTok, Instagram and X forbid automated downloading in their terms, so
SoftwareFactory refuses their links; save the clip from the app and give its file. A file is uploaded to Gemini's Files
API (up to 1 GB), watched, and deleted there right after. Add-ons may watch links only, never files, so an add-on cannot
send a file from this computer to Google.

## Storage

Notes live in `video_notes` and `video_notes_fts` (FTS5), written directly like add-on catalogs. Events:
`video.watched` (source, title, model, tokens, paid-key cost, whether it came from the notes), `video.failed`,
`video.key` (set or removed, last four characters only), `video.settings`.
