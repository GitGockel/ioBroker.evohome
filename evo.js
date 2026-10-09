/** @file
 * Evohome / Total Connect Comfort EMEA client.
 *
 * Notes:
 * - Uses the Resideo EMEA REST API, not the legacy TC2 SOAP endpoint.
 * - The OAuth password grant and legacy EMEA routes may no longer be
 *   supported for every account. Configure the endpoints for your service.
 * - Never log or publish credentials, client secrets, or access tokens.
 */
'use strict';

const req = require('request-promise-native');
const assert = require('assert');
const sprintf = require('sprintf-js');

const API_BASE = (process.env.EVOHOME_API_BASE || 'https://tccna.resideo.com').replace(/\/+$/, '');
const TOKEN_URL = process.env.EVOHOME_TOKEN_URL || `${API_BASE}/Auth/OAuth/Token`;
const APPID = process.env.EVOHOME_APP_ID || '91db1612-73fd-4500-91b2-e63b069b185c';
const CLIENT_CREDENTIALS = process.env.EVOHOME_CLIENT_CREDENTIALS ||
    'NGEyMzEwODktZDJiNi00MWJkLWE1ZWItMTZhMGE0MjJiOTk5OjFhMTVjZGI4LTQyZGUtNDA3Yi1hZGQwLTA1OWY5MmM1MzBjYg==';
const API_PREFIX = process.env.EVOHOME_API_PREFIX || '/WebAPI/emea/api/v1';

class BadStructure extends Error {
    constructor(message) {
        super(message);
        this.name = 'BadStructure';
    }
}

function apiUrl(path) {
    return `${API_BASE}${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

function responseMessage(error) {
    const status = error && error.statusCode ? `HTTP ${error.statusCode}` : 'Request failed';
    let body = error && error.error;
    if (body && typeof body !== 'string') {
        try { body = JSON.stringify(body); } catch (_) { body = String(body); }
    }
    if (typeof body === 'string') body = body.slice(0, 1200);
    return `${status}: ${body || (error && error.message) || 'Unknown error'}`;
}

class Evo {
    constructor(user, pass, appId) {
        this.username = user;
        this.password = pass;
        this.appId = appId || APPID;
        this.installation = undefined;
        this.userAccount = undefined;
        this.access_token = undefined;
        this.access_token_expires = undefined;
        this.system = undefined;
        this.label = 'EVO';
        this.log = console;
        this.onCommand = undefined;
        this.structureError = '';
        this._headers = undefined;
    }

    static createDailySchedule() {
        return new DailySchedule();
    }

    static toDateTimeString(d) {
        if (!d || typeof d === 'string') return d;
        return d.toISOString();
    }

    async _basicLogin() {
        if (!this.username || !this.password) {
            throw new Error('Evohome: Username und Passwort müssen gesetzt sein.');
        }

        const options = {
            method: 'POST',
            uri: TOKEN_URL,
            headers: {
                'User-Agent': 'EvohomeClient/1.0',
                'Authorization': `Basic ${CLIENT_CREDENTIALS}`,
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                'Cache-Control': 'no-store',
                'Pragma': 'no-cache'
            },
            form: {
                grant_type: 'password',
                scope: 'EMEA-V1-Basic EMEA-V1-Anonymous EMEA-V1-Get-Current-User-Account',
                Username: this.username,
                Password: this.password
            },
            json: true,
            resolveWithFullResponse: true,
            simple: true,
            timeout: 20000
        };

        let response;
        try {
            response = await req(options);
        } catch (error) {
            throw new Error(`Evohome OAuth-Login fehlgeschlagen (${responseMessage(error)}). ` +
                `Token-URL: ${TOKEN_URL}. Prüfe, ob dieser Token-Endpunkt für dein Konto noch unterstützt wird.`);
        }

        const body = response.body;
        if (!body || !body.access_token) {
            throw new Error('Evohome OAuth-Login: Antwort enthält kein access_token.');
        }

        this.access_token = body.access_token;
        const expiresIn = Number(body.expires_in) || 3600;
        this.access_token_expires = new Date(Date.now() + Math.max(0, expiresIn - 30) * 1000);
        this._headers = {
            Authorization: `Bearer ${this.access_token}`,
            Accept: 'application/json, application/xml, text/json, text/x-json, text/javascript, text/xml'
        };
        return body;
    }

    async headers(json) {
        if (!this.access_token || !this.access_token_expires ||
            Date.now() >= this.access_token_expires.getTime()) {
            await this._basicLogin();
        }
        const headers = Object.assign({}, this._headers);
        if (json) headers['Content-Type'] = 'application/json';
        return headers;
    }

    async _api(options) {
        const opts = Object.assign({
            json: true,
            timeout: 20000,
            resolveWithFullResponse: false
        }, options);
        try {
            return await req(opts);
        } catch (error) {
            throw new Error(`Evohome API ${opts.method || 'GET'} ${opts.uri} fehlgeschlagen: ${responseMessage(error)}`);
        }
    }

    async getUserAccount() {
        this.userAccount = await this._api({
            method: 'GET',
            uri: apiUrl('/userAccount'),
            headers: await this.headers()
        });
        return this.userAccount;
    }

    async getInstallation() {
        if (!this.userAccount || !this.userAccount.userId) {
            throw new Error('Evohome: getUserAccount() muss vor getInstallation() erfolgreich sein.');
        }
        const uri = apiUrl(`/location/installationInfo?userId=${encodeURIComponent(this.userAccount.userId)}&includeTemperatureControlSystems=True`);
        this.installation = await this._api({
            method: 'GET',
            uri,
            headers: await this.headers()
        });

        if (!Array.isArray(this.installation)) {
            throw new Error('Evohome: Unerwartetes Installationsformat (erwartet wurde ein Array).');
        }

        this.system = undefined;
        for (let i = 0; i < this.installation.length; ++i) {
            const loc = new Location(this, this.installation[i]);
            this.installation[i] = loc;
            for (let j = 0; j < (loc.gateways || []).length; ++j) {
                const gateway = new Gateway(loc, loc.gateways[j]);
                loc.gateways[j] = gateway;
                for (let k = 0; k < (gateway.temperatureControlSystems || []).length; ++k) {
                    const system = new TemperatureControlSystem(gateway, gateway.temperatureControlSystems[k]);
                    gateway.temperatureControlSystems[k] = system;
                    for (let l = 0; l < (system.zones || []).length; ++l) {
                        system.zones[l] = system.makeZoneObject(l);
                    }
                    if (this.system === undefined) this.system = system;
                    else this.system = null;
                }
            }
        }
        this.structureError = '';
        return this.installation;
    }

    async login() {
        await this._basicLogin();
        await this.getUserAccount();
        await this.getInstallation();
        return this.installation;
    }

    async getStatus(quick) {
        if (!Array.isArray(this.installation)) {
            throw new Error('Evohome: Erst login() aufrufen.');
        }
        let status;
        for (const location of this.installation) status = await location.getStatus(quick);
        return status;
    }

    userId() {
        return this.userAccount && this.userAccount.userId;
    }

    setStructureError(err) {
        if (!this.structureError) this.structureError = err;
    }

    *locations() {
        for (const location of (this.installation || [])) yield location;
    }
}

class Location {
    constructor(evo, data) {
        Object.assign(this, data);
        this.$evo = evo;
        this.label = 'LOCATION';
        assert(this.gateways !== undefined, 'Location ohne gateways');
    }

    async getStatus(quick) {
        const locationId = this.locationInfo && this.locationInfo.locationId;
        if (locationId === undefined) throw new BadStructure('Location hat keine locationId.');
        const uri = apiUrl(`/location/${encodeURIComponent(locationId)}/status?includeTemperatureControlSystems=True`);
        this.$status = await this.$evo._api({
            method: 'GET', uri, headers: await this.$evo.headers()
        });

        for (const gatewayStatus of (this.$status.gateways || [])) {
            const gateway = this.gatewayById(gatewayStatus.gatewayId, false);
            if (!gateway) {
                this.$evo.setStructureError(`Unknown gateway in status ${gatewayStatus.gatewayId}`);
                continue;
            }
            gateway.$status = gatewayStatus;

            for (const systemStatus of (gatewayStatus.temperatureControlSystems || [])) {
                const system = gateway.controlSystemById(systemStatus.systemId, false);
                if (!system) {
                    this.$evo.setStructureError(`Unknown Control System in status ${systemStatus.systemId}`);
                    continue;
                }
                system.$status = systemStatus;

                for (const zoneStatus of (systemStatus.zones || [])) {
                    const zone = system.zoneById(zoneStatus.zoneId, false);
                    if (!zone) {
                        this.$evo.setStructureError(`Unknown Zone in status ${zoneStatus.zoneId}`);
                        continue;
                    }
                    zone.status = zoneStatus;
                    if (!quick) await zone.getSchedule();
                }
            }
        }
        return this.$status;
    }

    gatewayById(id, mandatory = false) {
        for (const gateway of (this.gateways || [])) {
            if (gateway.id() === id) return gateway;
        }
        if (mandatory) throw new BadStructure(`No gateway [${id}]`);
        return undefined;
    }

    *_gateways() { for (const gateway of (this.gateways || [])) yield gateway; }
    name() { return this.locationInfo && this.locationInfo.name; }

    async doSystemCommand(command) {
        if (typeof command === 'string') command = JSON.parse(command);
        for (const gateway of (this.gateways || [])) {
            for (const system of (gateway.temperatureControlSystems || [])) {
                await system.doSystemCommand(command);
            }
        }
    }
}

class Gateway {
    constructor(location, data) {
        Object.assign(this, data);
        this.$location = location;
        this.$evo = location.$evo;
        assert(this.$evo && this.$evo.label === 'EVO');
    }
    id() { return this.gatewayInfo && this.gatewayInfo.gatewayId; }
    controlSystemById(id, mandatory = false) {
        for (const system of (this.temperatureControlSystems || [])) {
            if (system.id() === id) return system;
        }
        if (mandatory) throw new BadStructure(`No controlsystem [${id}]`);
        return undefined;
    }
    *systems() { for (const system of (this.temperatureControlSystems || [])) yield system; }
}

class TemperatureControlSystem {
    constructor(gateway, data) {
        Object.assign(this, data);
        this.$gateway = gateway;
        this.$evo = gateway.$evo;
        assert(this.$evo && this.$evo.label === 'EVO');
    }

    makeZoneObject(index) { return new HeatZone(this, this.zones[index]); }
    id() { return this.systemId; }

    zoneByName(name, mandatory = false) {
        for (const zone of (this.zones || [])) {
            if (zone.name === name) return zone;
        }
        if (mandatory) throw new BadStructure(`No zone named [${name}]`);
        return undefined;
    }

    zoneById(id, mandatory = false) {
        for (const zone of (this.zones || [])) {
            if (zone.zoneId === id) return zone;
        }
        if (mandatory) throw new BadStructure(`No zone with id [${id}]`);
        return undefined;
    }

    *_zones() { for (const zone of (this.zones || [])) yield zone; }

    async setMode(mode, until) {
        const body = until
            ? { SystemMode: mode, TimeUntil: until instanceof Date ? until.toISOString() : until, Permanent: false }
            : { SystemMode: mode, Permanent: true };
        const uri = apiUrl(`/temperatureControlSystem/${encodeURIComponent(this.id())}/mode`);
        this.$status = await this.$evo._api({
            method: 'PUT', uri, headers: await this.$evo.headers(true), body
        });
        if (this.$evo.onCommand) {
            await this.$evo.onCommand({ cmd: 'setmode', until, system: this });
        }
    }

    async setModeNormal(until) { return this.setMode('Auto', until); }
    async setModeReset(until) { return this.setMode('AutoWithReset', until); }
    async setModeCustom(until) { return this.setMode('Custom', until); }
    async setModeEco(until) { return this.setMode('AutoWithEco', until); }
    async setModeAway(until) { return this.setMode('Away', until); }
    async setModeDayOff(until) { return this.setMode('DayOff', until); }
    async setModeOff(until) { return this.setMode('HeatingOff', until); }

    async doSystemCommand(command) {
        if (typeof command === 'string') command = JSON.parse(command);
        switch (command.command) {
            case 'setmode': return this.setMode(command.mode, command.until);
            default: throw new Error(`Unsupported TemperatureController command [${command.command}]`);
        }
    }
}

class ZoneBase {
    constructor(system) {
        this.$system = system;
        this.$evo = system.$evo;
        assert(this.$evo && this.$evo.label === 'EVO');
    }

    state() {
        if (!this.status) {
            return { temperature: undefined, isAvailable: undefined, setpoint: undefined, setpointMode: undefined, faults: undefined };
        }
        const temperatureStatus = this.status.temperatureStatus || {};
        const setpointStatus = this.status.setpointStatus || {};
        return {
            schedule: this.$schedule,
            temperature: temperatureStatus.temperature,
            isAvailable: temperatureStatus.isAvailable,
            setpoint: setpointStatus.targetHeatTemperature,
            setpointMode: setpointStatus.setpointMode,
            until: setpointStatus.until,
            faults: this.status.activeFaults
        };
    }

    getURI() {
        return apiUrl(`/${this.zone_type}/${encodeURIComponent(this.zoneId)}`);
    }

    async getSchedule() {
        const uri = `${this.getURI()}/schedule`;
        const schedule = await this.$evo._api({
            method: 'GET', uri, headers: await this.$evo.headers()
        });
        this.$schedule = new DailySchedule(schedule, this.$evo.log);
        return this.$schedule;
    }

    async setSchedule(schedule) {
        if (typeof schedule === 'string') schedule = JSON.parse(schedule);
        const uri = `${this.getURI()}/schedule`;
        await this.$evo._api({
            method: 'PUT', uri, headers: await this.$evo.headers(true), body: schedule
        });
        if (this.$evo.onCommand) await this.$evo.onCommand({ cmd: 'setschedule', zone: this });
        this.$schedule = new DailySchedule(schedule, this.$evo.log);
    }

    async doZoneCommand(command) {
        if (typeof command === 'string') command = JSON.parse(command);
        switch (command.command) {
            case 'SetSchedule': return this.setSchedule(command.schedule);
            default: throw new Error(`Unsupported Zone command [${command.command}]`);
        }
    }
}

class HeatZone extends ZoneBase {
    constructor(system, data) {
        super(system);
        Object.assign(this, data);
        this.zone_type = 'temperatureZone';
        assert(this.$evo && this.$evo.label === 'EVO');
    }

    async doZoneCommand(command) {
        if (typeof command === 'string') command = JSON.parse(command);
        switch (command.command) {
            case 'Override': return this.setTemperature(command.setpoint, command.until);
            case 'CancelOverride': return this.cancelTemperatureOverride();
            default: return super.doZoneCommand(command);
        }
    }

    async setTemperature(temperature, until) {
        const data = { HeatSetpointValue: temperature };
        if (until === 'next-switchpoint') {
            if (!this.$schedule) await this.getSchedule();
            const iterator = this.$schedule.iterator();
            until = iterator.switchpointDateTime();
            if (!until) throw new Error('Kein nächster Schaltpunkt im Zeitplan gefunden.');
        }
        if (until) {
            data.SetpointMode = 'TemporaryOverride';
            data.TimeUntil = Evo.toDateTimeString(until);
        } else {
            data.SetpointMode = 'PermanentOverride';
        }
        return this._setHeatSetpoint(data);
    }

    async _setHeatSetpoint(data) {
        const uri = `${this.getURI()}/heatSetpoint`;
        await this.$evo._api({
            method: 'PUT', uri, headers: await this.$evo.headers(true), body: data
        });
        if (this.$evo.onCommand) {
            await this.$evo.onCommand({
                cmd: 'setheatsetpoint', mode: data.SetpointMode,
                until: data.TimeUntil, zone: this
            });
        }
    }

    async cancelTemperatureOverride() {
        return this._setHeatSetpoint({
            SetpointMode: 'FollowSchedule',
            HeatSetpointValue: 0.0
        });
    }
}

class ScheduleIterator {
    constructor(schedule, atime, log) {
        const time = new Date(atime.getTime());
        this.schedule = schedule;
        const seconds = time.getHours() * 3600 + time.getMinutes() * 60 + time.getSeconds();
        this.baseday = new Date(atime.getTime());
        this.baseday.setHours(0, 0, 0, 0);
        this.dow = (time.getDay() + 6) % 7;
        this.index = 0;
        this.dayoffset = 0;
        this.invalid = false;
        this.$log = log;
        this.adjust();
        let guard = 0;
        while (!this.invalid && this.dayoffset === 0 && this.switchpoint().secondsInDay() < seconds) {
            this.next();
            if (++guard > 100) throw new Error('Invalid schedule: too many switchpoints.');
        }
    }

    adjust() {
        let count = 0;
        while (!this.invalid) {
            const day = this.schedule.dailySchedules[this.dow];
            if (day && this.index < day.switchpoints.length) return;
            if (++count >= 8) {
                this.invalid = true;
                throw new Error('No schedule found!');
            }
            ++this.dayoffset;
            this.dow = (this.dow + 1) % 7;
            this.index = 0;
        }
    }

    next() { ++this.index; this.adjust(); }

    switchpoint() {
        if (this.invalid) return undefined;
        const day = this.schedule.dailySchedules[this.dow];
        return day && day.switchpoints[this.index];
    }

    switchpointDateTime() {
        if (this.invalid) return undefined;
        const point = this.switchpoint();
        const date = new Date(this.baseday.getTime());
        date.setDate(date.getDate() + this.dayoffset);
        date.setSeconds(point.secondsInDay());
        return date;
    }
}

class DailySchedule {
    constructor(raw, log) {
        this.$log = log;
        if (raw) {
            Object.assign(this, raw);
            this.dailySchedules = (this.dailySchedules || []).map(day => new DaySchedule(day));
        } else {
            this.dailySchedules = DailySchedule.days().map(day => new DaySchedule(null, day));
        }
    }

    static days() {
        return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    }

    getDay(indexOrName) {
        if (typeof indexOrName === 'number') return this.dailySchedules[indexOrName];
        return this.dailySchedules.find(day =>
            indexOrName.localeCompare(day.dayOfWeek, undefined, { sensitivity: 'base' }) === 0
        );
    }

    iterator(time) { return new ScheduleIterator(this, time || new Date(), this.$log); }
}

class DaySchedule {
    constructor(raw, dayOfWeek) {
        if (raw) {
            Object.assign(this, raw);
            this.switchpoints = (this.switchpoints || []).map(point => new HeatSwitchpoint(point));
        } else {
            this.switchpoints = [];
            this.dayOfWeek = dayOfWeek;
        }
    }

    createSwitchPoint(value, timeOfDay) {
        const point = new HeatSwitchpoint(null, value, timeOfDay);
        this.switchpoints.push(point);
        this.rationaliseSwitchpoints(point);
        return point;
    }

    rationaliseSwitchpoints() {
        this.switchpoints.sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));
        for (let i = this.switchpoints.length - 2; i >= 0; --i) {
            const a = this.switchpoints[i];
            const b = this.switchpoints[i + 1];
            if (a.timeOfDay === b.timeOfDay) {
                if (Array.from(arguments).includes(a)) this.switchpoints.splice(i + 1, 1);
                else this.switchpoints.splice(i, 1);
            }
        }
    }
}

class HeatSwitchpoint {
    constructor(raw, value, timeOfDay) {
        if (raw) Object.assign(this, raw);
        else {
            this.heatSetpoint = value === undefined ? 5.0 : value;
            this.timeOfDay = timeOfDay || '00:00:00';
        }
    }

    secondsInDay(set) {
        if (set === undefined) {
            const parts = this.timeOfDay.split(':').map(Number);
            return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        }
        const seconds = set % 60;
        set = Math.floor(set / 60);
        const minutes = set % 60;
        const hours = Math.floor(set / 60);
        this.timeOfDay = sprintf.sprintf('%02d:%02d:%02d', hours, minutes, seconds);
    }
}

module.exports = Evo;
