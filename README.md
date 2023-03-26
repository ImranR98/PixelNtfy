# PixelNtfy

A simple [tracking pixel](https://en.wikipedia.org/wiki/Web_beacon) generator that uses [ntfy](https://ntfy.sh/) for pixel access alerts.

Each pixel is associated with a tag and a timestamp that are included in the access notification. This service is stateless, meaning it has no database - pixel-associated info is stored in the pixel URL itself.

This service is meant to be self-hosted and single-user. To prevent unauthorized usage, the ntfy topic doubles as a password, and must be provided when the pixel is generated.

Environment variables needed (a `.env` file can be used for this):
- `NTFY_TOPIC`: The ntfy topic (if not provided, a topic is auto-generated and printed to the console).
- `NTFY_SERVER_URL`: The ntfy server URL (optional - defaults to [ntfy.sh](https://ntfy.sh)).
- `PORT`: The port to listen on (optional - defaults to `3000`).