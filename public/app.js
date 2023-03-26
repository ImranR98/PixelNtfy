const form = document.querySelector('#createPixelForm')
const saveTopicCheckbox = document.querySelector('#saveTopicCheckbox')
const ntfyPassword = document.querySelector('#topicInput')
const tagInput = document.querySelector('#tagInput')
const pixelCode = document.querySelector('#pixelCode')
const pixelCode2 = document.querySelector('#pixelCode2')
const pixelPreview = document.querySelector('#pixelPreview')
const errorContainer = document.querySelector('#errorContainer')
const pixelPreview2 = document.querySelector('#pixelPreview2')
const errorContainer2 = document.querySelector('#errorContainer2')
const errorDiv = document.querySelector('#errorDiv')

const savedPassword = localStorage.getItem('ntfy-password')

if (savedPassword) {
    ntfyPassword.value = savedPassword
    saveTopicCheckbox.checked = true
}

form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const tag = tagInput.value
    const ntfyTopic = ntfyPassword.value
    const requestBody = {
        tag,
        ntfyTopic,
    }
    const response = await fetch('/tracking', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    })
    if (response.status == 200) {
        if (saveTopicCheckbox.checked) {
            localStorage.setItem('ntfy-password', ntfyTopic)
        }
        const body = await response.json();
        pixelPreview.style.display = 'block'
        pixelPreview2.style.display = 'block'
        errorContainer.style.display = 'none'
        pixelCode.value = body.pixelUrl
        pixelCode2.value = body.imgTag
    } else {
        pixelPreview.style.display = 'none'
        pixelPreview2.style.display = 'none'
        errorContainer.style.display = 'block'
        errorDiv.innerHTML = (await response.text()) || response.statusText
    }
})

const copyCode = (id) => {
    navigator.clipboard.writeText(document.querySelector(`#${id}`).value)
}