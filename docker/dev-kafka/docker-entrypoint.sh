#!/bin/bash
set -eo pipefail

_term() {
    echo "🚨 Termination signal received...";
    kill -TERM "$child" 2>/dev/null
}

trap _term SIGINT SIGTERM

properties_file=/opt/kafka/config/kraft/server.properties;
kafka_addr=localhost:9093;

echo "==> Applying environment variables...";

HOST_IP="$(hostname -i)"

echo "listeners=CONTROLLER://:19092,CLIENTS://:9092,BROKERS://:9093" >> $properties_file;
echo "advertised.listeners=CLIENTS://${HOST_IP}:9092,BROKERS://${HOST_IP}:9093" >> $properties_file;
echo "inter.broker.listener.name=BROKERS" >> $properties_file;
echo "listener.security.protocol.map=CONTROLLER:PLAINTEXT,CLIENTS:PLAINTEXT,BROKERS:PLAINTEXT" >> $properties_file;
echo "==> ✅ Enivronment variables applied.";


if [ -f /kafka-logs/meta.properties ]; then
    echo "==> ✅ Kafka storage already exists.";
else
    echo "==> Setting up Kafka storage...";
    export suuid=$(./bin/kafka-storage.sh random-uuid);
    ./bin/kafka-storage.sh format -t $suuid -c ./config/kraft/server.properties;
    echo "==> ✅ Kafka storage setup.";
fi


echo "==> Starting Kafka server...";
./bin/kafka-server-start.sh ./config/kraft/server.properties &
child=$!
echo "==> Kafka server started...";
./wait-for-it.sh $kafka_addr;
echo "==> ✅ Kafka server running.";

echo "==> Ensuring topics...";

# @todo: Deal with already existing topics better
for topic in inputEvents feedStatus bigQuery; do
    ./topics.sh --create --topic "$topic" \
        --partitions "1"  --replication-factor 1 || true;
done

./configs.sh --alter --topic feedStatus --add-config cleanup.policy=compact

echo "==> ✅ Requested topics created.";

wait "$child";
