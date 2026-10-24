'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
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

test('serves the pixel generator page', async () => {
    const response = await fetch(`${baseUrl}/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    const body = await response.text()
    assert.match(body, /<title>PixelNtfy<\/title>/)
    assert.match(body, /id="createPixelForm"/)
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
    assert.match(notification.body, /From 203\.0\.113\.7 at /)
    assert.match(notification.body, /\[PixelNtfy-Test\/1\.0\]/)
})

test('sends the ntfy access token as basic auth', async () => {
    process.env.NTFY_TOKEN = 'test-token'
    const generated = await generatePixel({ tag: 'authenticated' })
    assert.equal(generated.status, 200)
    const { pixelUrl } = await generated.json()

    const accessed = await accessPixel(pixelUrl)
    assert.equal(accessed.status, 200)
    assert.equal(notifications.length, 1)
    assert.equal(
        notifications[0].headers.authorization,
        `Basic ${Buffer.from(':test-token').toString('base64')}`
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

test('rejects pixel generation without the correct ntfy topic', async () => {
    const response = await generatePixel({ tag: 'unauthorized', ntfyTopic: 'wrong-topic' })
    assert.equal(response.status, 403)
    assert.equal(await response.text(), 'Forbidden')
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

test('returns 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`)
    assert.equal(response.status, 404)
})
