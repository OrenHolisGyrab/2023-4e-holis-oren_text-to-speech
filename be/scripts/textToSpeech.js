const {validateStringNotEmpty, validateType} = require('./utils/validations.js');
const {ApiError} = require("./utils/aexpress.js");
const express = require('express');
const SQLBuilder = require("./utils/SQLBuilder.js");
const fs = require('fs');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const { Buffer } = require('buffer');
const { PassThrough } = require('stream');
const axios = require('axios')
const env = require("./env.js");
const {parseId, replaceSpecialLetters} = require("./utils/utils");

let app = express();
const db = new SQLBuilder();

async function getToken(tx) {
	return await db.select('microsoft_tokens')
		.where('id IS NOT NULL')
		.oneOrNone(tx);
}

class TextToSpeech {
	async getPrescriptionBearerToken(token) {
		token = token || await getToken();

		return await axios.post(`https://${token.region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`, null, {
			headers: {
				'Ocp-Apim-Subscription-Key': token.token,
				'Host': `${token.region}.api.cognitive.microsoft.com`,
				'Content-type': 'application/x-www-form-urlencoded',
				'Content-Length': 0
			}
		});
	}

	async countRecordGenerated(user, recordId) {
		const date = new Date();
		const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);

		await db.insert('records_generated_count', {
			"user": user.id,
			company: user.company,
			count: 1,
			date: firstDay,
			record: recordId
		})
		.more('ON CONFLICT (date, "user", company, record) DO UPDATE SET count = "records_generated_count".count + 1')
		.run();
	}

	async validateToken(token, region) {
		try {
			await this.getPrescriptionBearerToken({token, region});
		} catch (ex) {
			throw new ApiError(401, 'Invalid token or region');
		}
	}

	async getVoiceList() {
		const microsoftToken = await getToken();
		const token = await this.getPrescriptionBearerToken();

		return await axios.get(`https://${microsoftToken.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
			headers: {
				Authorization: `Bearer ${token.data}`,
				'Host': `${microsoftToken.region}.tts.speech.microsoft.com`
			}
		})
	}

	async getLanguages() {
		return await db.select('speech_records_languages')
			.fields('language, id')
			.getList();
	}

	async saveEnvironmentLanguages() {
		const actualEnvironmentLanguages = (await this.getLanguages()).map(lang => lang.language);
		const voiceList = (await this.getVoiceList()).data;
		let appliedLanguages = new Set();

		for (const lang of voiceList) {
			const state = lang.LocaleName.replace(/ (.)+/g, '');

			if (env.azure_tts.languages.includes(state)) {
				appliedLanguages.add(state);

				if (actualEnvironmentLanguages.includes(state)) {
					continue;
				}

				let languageInserted = await db.select('speech_records_languages')
					.where('language = ?', state)
					.where('language_key = ?', lang.Locale)
					.oneOrNone();

				if (!languageInserted) {
					languageInserted = await db.insert('speech_records_languages', {
						language: state,
						language_key: lang.Locale
					})
					.oneOrNone()
				}

				await db.insert('speech_records_voices', {
					language: languageInserted.id,
					speaker: lang.DisplayName,
					speaker_sex: lang.Gender.slice(0, 1)
				})
				.run()
			}
		}
	}

	async getLanguage(id) {
		return await db.select('speech_records_languages')
			.where('id = ?', id)
			.oneOrNone();
	}

	async getLanguageSpeakers(languageId) {
		return await db.select('speech_records_voices')
			.where('language = ?', languageId)
			.getList();
	}

	async checkLanguage(id) {
		const language = await this.getLanguage(id);

		if (!language) {
			throw new ApiError(404, 'Language not found');
		}

		return language;
	}

	async validateLanguageSpeakerMatch(langId, speakerId) {
		const voices = await textToSpeech.getLanguageSpeakers(langId)

		let voice;
		for (let i = 0; i < voices.length; i++) {
			if (voices[i].id === speakerId) {
				voice = voices[i];
				break;
			} else if (i + 1 === voices.length) {
				throw new ApiError(404, 'Voice not found');
			}
		}

		return voice
	}

	buildRecordGet() {
		return db.select('speech_records')
			.fields('sr.id, srl.language, sr.name, sr.rate, sr.pitch, speaker, region, text')
			.from(
				'speech_records AS sr',
				'INNER JOIN speech_records_languages AS srl ON sr.language = srl.id',
				'INNER JOIN speech_records_voices AS srv ON srv.id = sr.voice'
			);
	}

	buildFilePath(id) {
		return `${env.datadir}/${id}.${env.files_output.extension}`
	}

	async createSpeechFile(user, text, recordId, {speaker, language, pitch, rate}) {
		const token = await getToken();
		await this.validateToken(token.token, token.region);
		await this.countRecordGenerated(user, recordId);

		return new Promise((resolve, reject) => {
			const filename = this.buildFilePath(recordId);
			const speechConfig = sdk.SpeechConfig.fromSubscription(token.token, token.region);

			let audioConfig = sdk.AudioConfig.fromAudioFileOutput(filename);

			const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);
			const ratioToPercents = ratio => {
				if (ratio < 1) {
					return `${(2 - ratio * 2) * -100}%`;
				}

				return `+${(ratio - 1) * 100}%`;
			}

			synthesizer.speakSsmlAsync(
				`
				<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language.language_key}">
				  <voice name="${language.language_key}-${speaker.speaker}Neural">
		            <prosody pitch="${ratioToPercents(pitch)}" rate="${ratioToPercents(rate)}">
		            	${text}
			        </prosody>
				  </voice>
				</speak>
				`,
				result => {

					const { audioData } = result;

					synthesizer.close();

					if (filename) {
						const audioFile = fs.createReadStream(filename);
						resolve(audioFile);
					} else {
						const bufferStream = new PassThrough();
						bufferStream.end(Buffer.from(audioData));
						resolve(bufferStream);
					}
				},
				error => {
					synthesizer.close();
					reject(error);
				});
		});
	};
}

const textToSpeech = new TextToSpeech();

async function checkSpeechRecord(id, user) {
	const record = await db.select('speech_records')
		.where('id = ?', id)
		.oneOrNone();

	if (user.role === 'U' && env.record_visibility_mode === 'peruser') {
		if (record.user !== user.id) {
			throw new ApiError(401, 'You can\'t access this record');
		}
	}

	if (!record) {
		throw new ApiError(404, 'Record not found');
	}

	return record;
}

app.get_json('/tts/languages', async () => {
	return await db.select('speech_records_languages')
		.fields('language_key, language, id')
		.getList();
});

app.get_json('/tts/speakers/:language([0-9]+)', async req => {
	const languageId = parseId(req.params.language);
	await textToSpeech.checkLanguage(languageId);

	return await textToSpeech.getLanguageSpeakers(languageId);
});

async function saveNewRecord(user, name, text, pregenerated, cfg) {
	const recordSaved = await db.insert('speech_records', {
		language: cfg.language.id,
		voice: cfg.speaker.id,
		text,
		pregenerated,
		name: replaceSpecialLetters(name || ""),
		"user": user.id,
		rate: cfg.rate,
		pitch: cfg.pitch
	})
		.oneOrNone();

	const generated = await textToSpeech.createSpeechFile(user, text, recordSaved.id, cfg);

	await db.update('speech_records')
		.set('path', generated.path)
		.where('id = ?', recordSaved.id)
		.run();

	return recordSaved;
}

async function updateActualRecord(id, text, user, cfg) {
	const originalRecord = await checkSpeechRecord(id, user);

	const record = await db.update('speech_records')
		.set({
			language: cfg.language.id,
			voice: cfg.speaker.id,
			text,
			pregenerated: originalRecord.pregenerated,
			rate: cfg.rate,
			pitch: cfg.pitch
		})
		.where('id = ?', id)
		.oneOrNone();

	await textToSpeech.createSpeechFile(user, text, id, cfg);

	return record;
}

app.post_json('/tts', async req => {
	let {text, languageId, speakerId, id, rate, pitch, name} = req.body;

	validateStringNotEmpty(text, 'Text');
	validateType(languageId, 'number');
	validateType(speakerId, 'number');
	validateType(pitch, 'number');
	validateType(rate, 'number');

	if (pitch < 0.5 || pitch > 2) {
		throw new ApiError(400, 'Invalid value pitch must be in range from 50 to 200');
	}

	if (rate < 0.5 || rate > 2) {
		throw new ApiError(400, 'Invalid value rate must be in range from 50 to 200');
	}

	const language = await textToSpeech.checkLanguage(languageId);
	const speaker = await textToSpeech.validateLanguageSpeakerMatch(languageId, speakerId);

	const recordCfg = {
		language,
		speaker,
		rate,
		pitch
	}

	if (!id) {
		return await saveNewRecord(req.session, name, text, true, recordCfg);
	}

	validateType(id, 'number');

	return await updateActualRecord(id, text, req.session, recordCfg)
});

app.post_json('/tts/:id([0-9]+)', async req => {
	const id = parseId(req.params.id);
	let {name} = req.body;
	await checkSpeechRecord(id, req.session);

	if (name && typeof name !== 'string') {
		throw new ApiError(400, 'Does not match type.')
	}

	const token = await getToken();

	await db.update('speech_records')
		.set({
			name: replaceSpecialLetters(name),
			pregenerated: false,
			region: token.region
		})
		.where('id = ?', id)
		.oneOrNone();
});

app.delete_json('/tts/:id([0-9]+)', async req => {
	const id = parseId(req.params.id);
	const record = await checkSpeechRecord(id, req.session);

	fs.unlinkSync(record.path);

	await db.delete('speech_records')
		.where('id = ?', id)
		.run();
});

app.post_json('/tts/duplicate/:id([0-9]+)', async req => {
	const id = parseId(req.params.id);
	const record = await checkSpeechRecord(id, req.session);

	return await db.transaction(async tx => {
		const recordSaved = await db.insert('speech_records', {
			language: record.language,
			voice: record.voice,
			text: record.text,
			region: record.region,
			pregenerated: false,
			name: replaceSpecialLetters(record.name),
			rate: record.rate,
			pitch: record.pitch
		})
		.oneOrNone(tx);

		const filePath = textToSpeech.buildFilePath(recordSaved.id);

		fs.copyFileSync(record.path, filePath)

		await db.update('speech_records')
			.set('path', filePath)
			.where('id = ?', recordSaved.id)
			.run(tx);

		let recordGet = await (textToSpeech.buildRecordGet()
			.where('sr.id = ?', recordSaved.id)
			.oneOrNone(tx));

		let activeRegion = await getToken();
		recordGet.editable = recordGet.region === (activeRegion ? activeRegion.region : null)

		return recordGet;
	})
});

app.get_json('/tts/record/list', async req => {
	let records = (textToSpeech.buildRecordGet()
		.where('pregenerated = ?', false)
		.more('ORDER BY name'));

	if (req.session.role === 'U' && env.record_visibility_mode === 'peruser') {
		records.where('"user" = ?', req.session.id);
	} else {
		records.where('sr.id IS NOT NULL');
	}

	records = await records.getList();

	let activeRegion = await getToken();
	activeRegion = activeRegion ? activeRegion.region : null;

	for (const rec of records) {
		rec.editable = rec.region === activeRegion;
	}

	return records
})

app.get_json('/tts/record/:id([0-9]+)', async req => {
	const id = parseId(req.params.id);
	await checkSpeechRecord(id, req.session);

	return db.select('speech_records')
		.where('id = ?', id)
		.oneOrNone();
});

async function checkFileRequest(req) {
	const id = parseId(req.params.id);
	return await checkSpeechRecord(id, req.session);
}

app.get_file('/tts/record/play/:id([0-9]+)', async (req, res) => {
	const record = await checkFileRequest(req);

	const range = req.headers.range || 'bytes=0-';
	const audioSize = fs.statSync(record.path).size;
	const CHUNK_SIZE = 10 ** 6;
	const start = Number(range.replace(/\D/g, ""));
	const end = Math.min(start + CHUNK_SIZE, audioSize - 1);
	const contentLength = end - start + 1;

	res.writeHead(206, {
		'Cache-Control': 'no-cache',
		'Content-Type': 'audio/' + env.files_output.extension,
		"Content-Range": `bytes ${start}-${end}/${audioSize}`,
		"Content-Length": contentLength
	});

	const fileX = fs.createReadStream(record.path, {start, end})
	fileX.pipe(res)
})

app.get_file('/tts/record/download/:id([0-9]+)', async (req, res) => {
	const record = await checkFileRequest(req);

	res.writeHead(200, {
		'Cache-Control': 'no-cache',
		'Content-Type': 'audio/' + env.files_output.extension,
		'Content-Disposition': `attachment; filename="${record.name}.${env.files_output.extension}"`
	});

	const fileX = fs.createReadStream(record.path);
	fileX.pipe(res)
});

module.exports = {app, TextToSpeech: textToSpeech};