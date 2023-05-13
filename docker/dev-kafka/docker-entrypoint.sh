#!/bin/bash

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


echo "==> Setting up Kafka storage...";
export suuid=$(./bin/kafka-storage.sh random-uuid);
./bin/kafka-storage.sh format -t $suuid -c ./config/kraft/server.properties;
echo "==> ✅ Kafka storage setup.";


echo "==> Starting Kafka server...";
./bin/kafka-server-start.sh ./config/kraft/server.properties &
child=$!
echo "==> ✅ Kafka server started.";

if [ -z $KRAFT_CREATE_TOPICS ]; then
    echo "==> No topic requested for creation.";
else
    echo "==> Creating topics...";
    ./wait-for-it.sh $kafka_addr;

    pc=1
    if [ $KRAFT_PARTITIONS_PER_TOPIC ]; then
        pc=$KRAFT_PARTITIONS_PER_TOPIC
    fi

    for i in $(echo $KRAFT_CREATE_TOPICS | sed "s/,/ /g")
    do
        ./bin/kafka-topics.sh --create --topic "$i" --partitions "$pc" --replication-factor 1 --bootstrap-server $kafka_addr;
    done
    echo "==> ✅ Requested topics created.";
fi


wait "$child";
