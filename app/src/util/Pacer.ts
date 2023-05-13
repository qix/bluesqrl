
export class Pacer {

    private last = 0;
    constructor(private intervalMs: number) {


    }

    test() {
        const now = Date.now();
        if (now > this.last + this.intervalMs) {
            this.last = now;
            return true;
        }
        return false;
    }
}
