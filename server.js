const express = require('express')
const axios = require('axios')
const dotenv = require('dotenv')
const crypto = require('crypto')
const app = express()

dotenv.config()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const port = process.env.PORT || 3000

if (!process.env.NTFY_TOPIC) {
    process.env.NTFY_TOPIC = crypto.randomBytes(16).toString('hex')
    console.log(`WARN: 'process.env.NTFY_TOPIC' was not defined! Set to: ${process.env.NTFY_TOPIC}`)
}

const ntfyTopic = process.env.NTFY_TOPIC
const ntfyServerUrl = process.env.NTFY_SERVER_URL || 'https://ntfy.sh'

app.use(express.static('public'))

app.get('/tracking/:id', async (req, res) => {
    try {
        const id = req.params.id
        let message = null
        try {
            message = parseTrackingPixelId(id)
        } catch (e) {
            console.warn(`Failed notify attempt from '${req.ip}': Bad pixel ID: ${id}`)
            return res.status(400).send()
        }
        const { tag, date, tagHash } = message
        if (tagHash != hashString(tag)) {
            console.warn(`Failed notify attempt from '${req.ip}': Wrong tag hash: ${id}`)
            return res.status(403).send('Forbidden')
        }
        const dateString = formatDate(date)
        const postUrl = `${ntfyServerUrl}/${ntfyTopic}`
        const accessTitle = `Pixel Accessed: "${tag}"`
        const getAccessDetails = (dateString, headers, includeHeaders) => {
            const lines = [
                `From ${headers['x-real-ip'] || headers['x-forwarded-for'] || 'Unknown IP'} at ${dateString}\n[${headers['user-agent']}]`
            ]
            if (includeHeaders) {
                lines.push('All Headers: ' + JSON.stringify(headers, null, '\t'))
            }
            return lines.join('\n\n')
        }
        console.log(`\n${accessTitle}\n${getAccessDetails(dateString, req.headers, true)}\n`)
        try {
            await axios.post(postUrl, getAccessDetails(dateString, req.headers), {
                headers: {
                    Title: accessTitle,
                }
            })
        } catch (error) {
            console.error('Error sending notification:', error.message)
        }
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
        res.set('Pragma', 'no-cache')
        res.set('Expires', '0')
        res.type('gif')
        res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
    } catch (err) {
        console.error(err)
        res.status(500).send()
    }
})

app.post('/tracking', (req, res) => {
    try {
        if (req.body.ntfyTopic !== ntfyTopic) {
            console.warn(`Unauthorized generate attempt from ${req.ip}: ${JSON.stringify(req.body)}`)
            return res.status(403).send('Forbidden')
        }
        const tag = req.body.tag
        const id = generateTrackingPixelId(tag)
        const pixelUrlOrigin = req.headers.referer
        const pixelUrlPath = `/tracking/${id}`
        const pixelUrl = new URL(pixelUrlPath, pixelUrlOrigin).toString()
        const imgTag = `<img src='${pixelUrl}'>`
        res.send({ pixelUrl, imgTag })
    } catch (err) {
        console.error(err)
        res.status(500).send()
    }
})

app.listen(port, () => {
    console.log('Server started on port', port)
})

const encrypt = (str, secretKey) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', secretKey, iv);
    const encrypted = cipher.update(str, 'utf8', 'base64') + cipher.final('base64');
    return Buffer.from(iv.toString('base64') + ':' + encrypted).toString('base64url');
}

const decrypt = (str, secretKey) => {
    const [iv, encrypted] = Buffer.from(str, 'base64').toString().split(':');
    const decipher = crypto.createDecipheriv('aes-256-ctr', secretKey, Buffer.from(iv, 'base64'));
    const decrypted = decipher.update(encrypted, 'base64', 'utf8') + decipher.final('utf8');
    return decrypted;
}

const hashString = (stringToHash) => {
    const hash = crypto.createHash('sha256');
    hash.update(stringToHash);
    return hash.digest('hex');
}

const generateTrackingPixelId = (tag) => encrypt(JSON.stringify({
    tag, date: Date.now(), tagHash: hashString(tag)
}), ntfyTopic)

const parseTrackingPixelId = (encodedId) => {
    const message = JSON.parse(decrypt(encodedId, ntfyTopic))
    message.date = new Date(message.date)
    return message
}

const formatDate = (date) => {
    let year = date.getFullYear();
    let month = ("0" + (date.getMonth() + 1)).slice(-2);
    let day = ("0" + date.getDate()).slice(-2);
    let hours = date.getHours();
    let minutes = date.getMinutes();
    let ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    minutes = minutes < 10 ? '0' + minutes : minutes;
    let strTime = hours + ':' + minutes + ' ' + ampm;
    return year + '-' + month + '-' + day + ' ' + strTime;
}
