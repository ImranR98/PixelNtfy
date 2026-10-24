'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { after, before, beforeEach, test } = require('node:test')

const TOPIC = '0123456789abcdef0123456789abcdef'

process.env.NTFY_TOPIC = TOPIC
delete process.env.NTFY_TOKEN
delete process.env.ANALYTICS_SCRIPT_ELEMENT

let app
let server
let baseUrl
let fakeNtfy
let notifications = []

const startFakeNtfy = () => new Promise((resolve, reject) => {
    fakeNtfy = http.createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
            notifications.push({ url: req.url, headers: req.headers, body })
            const failed = (req.headers.title || '').includes('fail-notify')
            res.writeHead(failed ? 500 : 200, { 'content-type': 'text/plain' })
            res.end(failed ? 'notification failed' : 'ok')
        })
    })
    fakeNtfy.once('error', reject)
    fakeNtfy.listen(0, '127.0.0.1', resolve)
})

const postTracking = ({ body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body)
    const requestHeaders = { ...headers }
    if (payload) {
        requestHeaders['content-length'] = String(payload.length)
    }
    const request = http.request(`${baseUrl}/tracking`, {
        method: 'POST',
        headers: requestHeaders
    }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
            resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString()
            })
        })
    })
    request.on('error', reject)
    if (payload) {
        request.write(payload)
    }
    request.end()
})

const generatePixel = ({ tag = 'front-door', ntfyTopic = TOPIC, referer = 'https://pixelntfy.example/' } = {}) => fetch(`${baseUrl}/tracking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag, ntfyTopic }),
    referrer: referer
})

const accessPixel = (pixelUrl, headers = {}) => {
    const { pathname } = new URL(pixelUrl)
    return fetch(`${baseUrl}${pathname}`, { headers })
}

before(async () => {
    await startFakeNtfy()
    process.env.NTFY_SERVER_URL = `http://127.0.0.1:${fakeNtfy.address().port}`
    ;({ app } = require('../server'))
    server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => fakeNtfy.close(resolve))
})

beforeEach(() => {
    notifications = []
    delete process.env.NTFY_TOKEN
})

test('serves the generator page and static assets', async () => {
    const page = await fetch(`${baseUrl}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /^text\/html/)
    const html = await page.text()
    assert.match(html, /<title>PixelNtfy<\/title>/)
    assert.match(html, /id="createPixelForm"/)

    const script = await fetch(`${baseUrl}/app.js`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /javascript/)
    assert.match(await script.text(), /createPixelForm/)

    const favicon = await fetch(`${baseUrl}/favicon.ico`)
    assert.equal(favicon.status, 200)
    assert.match(favicon.headers.get('content-type'), /^image\//)
    assert.ok((await favicon.arrayBuffer()).byteLength > 0)

    const head = await fetch(`${baseUrl}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
})

test('generates a pixel and notifies ntfy when the pixel is accessed', async () => {
    const generated = await generatePixel()
    assert.equal(generated.status, 200)
    const { pixelUrl, imgTag } = await generated.json()

    assert.match(pixelUrl, /^https:\/\/pixelntfy\.example\/tracking\/[A-Za-z0-9_-]+$/)
    assert.equal(imgTag, `<img src='${pixelUrl}'>`)

    const accessed = await accessPixel(pixelUrl, {
        'x-forwarded-for': '203.0.113.7',
        'user-agent': 'PixelNtfy-Test/1.0'
    })
    assert.equal(accessed.status, 200)
    assert.match(accessed.headers.get('content-type'), /^image\/gif/)
    assert.match(accessed.headers.get('cache-control'), /no-store/)
    assert.equal(accessed.headers.get('pragma'), 'no-cache')
    assert.equal(accessed.headers.get('expires'), '0')
    assert.ok((await accessed.arrayBuffer()).byteLength > 0)

    assert.equal(notifications.length, 1)
    const [notification] = notifications
    assert.equal(notification.url, `/${TOPIC}`)
    assert.equal(notification.headers.title, 'Pixel Accessed: "front-door"')
    assert.equal(notification.headers.authorization, undefined)
    assert.match(notification.body, /From 203\.0\.113\.7 at \d{4}-\d{2}-\d{2} \d{1,2}:\d{2} (AM|PM)/)
    assert.match(notification.body, /\[PixelNtfy-Test\/1\.0\]/)
})

test('accepts form-urlencoded generation requests', async () => {
    const response = await postTracking({
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            referer: 'https://forms.example/'
        },
        body: new URLSearchParams({ tag: 'form-pixel', ntfyTopic: TOPIC }).toString()
    })
    assert.equal(response.status, 200)
    const { pixelUrl } = JSON.parse(response.body)
    assert.match(pixelUrl, /^https:\/\/forms\.example\/tracking\/[A-Za-z0-9_-]+$/)

    const accessed = await accessPixel(pixelUrl)
    assert.equal(accessed.status, 200)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].headers.title, 'Pixel Accessed: "form-pixel"')
})

test('builds the pixel URL from the referer origin, ignoring its path', async () => {
    const response = await postTracking({
        headers: {
            'content-type': 'application/json',
            referer: 'https://pixelntfy.example/nested/page?foo=bar#fragment'
        },
        body: JSON.stringify({ tag: 'referer-path', ntfyTopic: TOPIC })
    })
    assert.equal(response.status, 200)
    const { pixelUrl } = JSON.parse(response.body)
    assert.match(pixelUrl, /^https:\/\/pixelntfy\.example\/tracking\/[A-Za-z0-9_-]+$/)
})

test('sends the ntfy access token as basic auth', async () => {
    process.env.NTFY_TOKEN = 'tok:en@value /'
    const generated = await generatePixel({ tag: 'authenticated' })
    assert.equal(generated.status, 200)
    const { pixelUrl } = await generated.json()

    const accessed = await accessPixel(pixelUrl)
    assert.equal(accessed.status, 200)
    assert.equal(notifications.length, 1)
    assert.equal(
        notifications[0].headers.authorization,
        `Basic ${Buffer.from(':tok:en@value /').toString('base64')}`
    )
})

test('rejects malformed pixel ids', async () => {
    const response = await fetch(`${baseUrl}/tracking/not-a-valid-pixel-id`)
    assert.equal(response.status, 400)
    assert.equal(notifications.length, 0)
})

test('rejects pixel ids whose tag hash does not match', async () => {
    const { encrypt, hashString } = require('../server')
    const forgedId = encrypt(JSON.stringify({
        tag: 'forged',
        date: Date.now(),
        tagHash: hashString('a-different-tag')
    }), TOPIC)

    const response = await fetch(`${baseUrl}/tracking/${forgedId}`)
    assert.equal(response.status, 403)
    assert.equal(await response.text(), 'Forbidden')
    assert.equal(notifications.length, 0)
})

test('rejects parsed pixels with an invalid tag without crashing', async () => {
    const { encrypt } = require('../server')
    const invalidId = encrypt(JSON.stringify({
        tag: { not: 'a string' },
        date: Date.now(),
        tagHash: 'irrelevant'
    }), TOPIC)

    const response = await fetch(`${baseUrl}/tracking/${invalidId}`)
    assert.equal(response.status, 500)
    assert.equal(notifications.length, 0)
})

test('rejects pixel generation without the correct ntfy topic', async () => {
    const response = await generatePixel({ tag: 'unauthorized', ntfyTopic: 'wrong-topic' })
    assert.equal(response.status, 403)
    assert.equal(await response.text(), 'Forbidden')
    assert.equal(notifications.length, 0)
})

test('rejects pixel generation when the body has no topic', async () => {
    const response = await postTracking({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'no-topic' })
    })
    assert.equal(response.status, 403)
    assert.equal(response.body, 'Forbidden')
    assert.equal(notifications.length, 0)
})

test('rejects malformed JSON request bodies', async () => {
    const response = await postTracking({
        headers: { 'content-type': 'application/json' },
        body: '{"tag":'
    })
    assert.equal(response.status, 400)
    assert.equal(notifications.length, 0)
})

test('returns 500 when the referer header is missing', async () => {
    const response = await postTracking({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'no-referer', ntfyTopic: TOPIC })
    })
    assert.equal(response.status, 500)
    assert.equal(notifications.length, 0)
})

test('still returns the pixel when the ntfy notification fails', async () => {
    const { generateTrackingPixelId } = require('../server')
    const response = await fetch(`${baseUrl}/tracking/${generateTrackingPixelId('fail-notify')}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^image\/gif/)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].headers.title, 'Pixel Accessed: "fail-notify"')
})

test('prefers x-real-ip over x-forwarded-for and falls back to Unknown IP', async () => {
    const generated = await generatePixel({ tag: 'ip-precedence' })
    assert.equal(generated.status, 200)
    const { pixelUrl } = await generated.json()

    const withRealIp = await accessPixel(pixelUrl, {
        'x-real-ip': '198.51.100.9',
        'x-forwarded-for': '203.0.113.99'
    })
    assert.equal(withRealIp.status, 200)
    assert.equal(notifications.length, 1)
    assert.match(notifications[0].body, /From 198\.51\.100\.9 at /)
    assert.doesNotMatch(notifications[0].body, /203\.0\.113\.99/)

    const withoutIpHeaders = await accessPixel(pixelUrl)
    assert.equal(withoutIpHeaders.status, 200)
    assert.equal(notifications.length, 2)
    assert.match(notifications[1].body, /From Unknown IP at /)
})

test('formats AM, PM, noon, midnight, and padded minutes', async () => {
    const { formatDate } = require('../server')
    assert.equal(formatDate(new Date(2026, 0, 2, 0, 5)), '2026-01-02 12:05 AM')
    assert.equal(formatDate(new Date(2026, 0, 2, 9, 5)), '2026-01-02 9:05 AM')
    assert.equal(formatDate(new Date(2026, 0, 2, 12, 5)), '2026-01-02 12:05 PM')
    assert.equal(formatDate(new Date(2026, 0, 2, 13, 5)), '2026-01-02 1:05 PM')
})

test('injects the analytics script only when enabled', async (t) => {
    const { applyAnalyticsScript } = require('../server')
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelntfy-analytics-'))
    const indexPath = path.join(workdir, 'index.html')
    const template = '<head><!-- ANALYTICS_SCRIPT_PLACEHOLDER --></head>'
    fs.writeFileSync(indexPath, template)

    t.after(() => {
        delete process.env.ANALYTICS_SCRIPT_ELEMENT
        fs.rmSync(workdir, { recursive: true, force: true })
    })

    delete process.env.ANALYTICS_SCRIPT_ELEMENT
    applyAnalyticsScript(indexPath)
    assert.equal(fs.readFileSync(indexPath, 'utf8'), template)

    process.env.ANALYTICS_SCRIPT_ELEMENT = 'not a script'
    applyAnalyticsScript(indexPath)
    assert.equal(fs.readFileSync(indexPath, 'utf8'), template)

    const element = '<script defer data-domain="pixelntfy.test" src="https://plausible.test/js/script.js"></script>'
    process.env.ANALYTICS_SCRIPT_ELEMENT = element
    applyAnalyticsScript(indexPath)
    assert.equal(fs.readFileSync(indexPath, 'utf8'), `<head>${element}</head>`)

    applyAnalyticsScript(indexPath)
    assert.equal(fs.readFileSync(indexPath, 'utf8'), `<head>${element}</head>`)
})

test('keeps tracking ids self-contained and unique', async () => {
    const { generateTrackingPixelId, parseTrackingPixelId, hashString } = require('../server')
    const first = generateTrackingPixelId('same-tag')
    const second = generateTrackingPixelId('same-tag')
    assert.notEqual(first, second)

    const parsed = parseTrackingPixelId(first)
    assert.equal(parsed.tag, 'same-tag')
    assert.equal(parsed.tagHash, hashString('same-tag'))
    assert.ok(parsed.date instanceof Date)
    assert.ok(Math.abs(Date.now() - parsed.date.getTime()) < 5000)
})

test('returns 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`)
    assert.equal(response.status, 404)
})
