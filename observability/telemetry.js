export class Telemetry {
  track(event, payload = {}) {
    console.log(
      JSON.stringify({
        type: 'TELEMETRY',
        event,
        payload,
        timestamp: new Date().toISOString(),
      })
    );
  }

  metric(name, value) {
    console.log(
      JSON.stringify({
        type: 'METRIC',
        name,
        value,
        timestamp: new Date().toISOString(),
      })
    );
  }
}

export const telemetry = new Telemetry();
