import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createApi } from './src/api';
import { MAX_BYTES, POLL_INTERVAL_MS } from './src/config';
import { ImportController } from './src/controller';
import {
  deleteCopy,
  opStore,
  pickFile,
  readHead,
  upload,
} from './src/nativeFiles';
import type { RecurringItem } from './src/types';

const money = (minor: number, cur: string) =>
  `${(minor / 100).toFixed(2)} ${cur}`;

function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.button,
        props.secondary && styles.buttonSecondary,
        props.disabled && styles.disabled,
      ]}>
      <Text style={[styles.buttonText, props.secondary && styles.secondaryText]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function App() {
  const controller = useMemo(
    () =>
      new ImportController(
        createApi(upload),
        {
          pick: () => pickFile(MAX_BYTES),
          readHead,
          deleteCopy,
        },
        opStore,
      ),
    [],
  );
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [details, setDetails] = useState<RecurringItem | null>(null);

  useEffect(() => {
    const off = controller.subscribe(rerender);
    controller.init();
    return off;
  }, [controller]);

  const { op, candidate, notice, busy } = controller.state;
  const polling = controller.needsPolling;

  useEffect(() => {
    if (!polling) {
      return;
    }
    const id = setInterval(() => controller.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [polling, controller]);

  const total = (op?.items ?? []).reduce((s, i) => s + i.amountMinor, 0);
  const deleted = op?.status === 'deleted';
  const deleting = op?.status === 'deleting';

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>
            Import statement
          </Text>

          {notice && (
            <Text accessibilityLiveRegion="polite" style={styles.notice}>
              {notice}
            </Text>
          )}
          {busy && <ActivityIndicator style={styles.spinner} />}

          {!op && !candidate && (
            <View>
              <Text style={styles.body}>
                No import yet. Choose a PDF or CSV statement.
              </Text>
              <Button label="Choose file" onPress={() => controller.choose()} disabled={busy} />
            </View>
          )}

          {candidate && (
            <View style={styles.card}>
              <Text style={styles.label}>Confirm file</Text>
              <Text style={styles.body}>Name: {candidate.fileName}</Text>
              <Text style={styles.body}>
                Size: {(candidate.size / 1024).toFixed(1)} KiB
              </Text>
              <Text style={styles.body}>
                Format: {candidate.format.toUpperCase()} (checked from contents)
              </Text>
              <Button label="Upload" onPress={() => controller.confirm()} />
              <Button
                label="Cancel"
                secondary
                onPress={() => controller.cancelCandidate()}
              />
            </View>
          )}

          {op && (
            <View style={styles.card}>
              <Text style={styles.body}>
                {op.fileName} ({op.format.toUpperCase()})
              </Text>

              {op.outcome === 'sending' && (
                <Text style={styles.body}>Sending…</Text>
              )}

              {op.outcome === 'unknown' && (
                <View>
                  <Text style={styles.label}>Upload result unknown</Text>
                  <Text style={styles.body}>
                    The connection dropped before we saw the answer. The server
                    may already have the file. Check first; nothing is resent
                    automatically.
                  </Text>
                  {op.error && <Text style={styles.notice}>{op.error}</Text>}
                  <Button
                    label="Check / retry upload"
                    onPress={() => controller.recover(true)}
                    disabled={busy}
                  />
                  <Button
                    label="Discard"
                    secondary
                    onPress={() => controller.dismiss()}
                  />
                </View>
              )}

              {op.outcome === 'created' && (
                <View>
                  <Text style={styles.label}>
                    Status: {op.status} (rev {op.revision})
                  </Text>
                  {(op.status === 'queued' || op.status === 'processing') && (
                    <Text style={styles.body}>Waiting for the report…</Text>
                  )}

                  {op.status === 'ready' && (
                    <View>
                      {(op.items ?? []).length === 0 && (
                        <Text style={styles.body}>No recurring charges found.</Text>
                      )}
                      {(op.items ?? []).map(i => (
                        <View key={i.id} style={styles.row}>
                          <View style={styles.rowText}>
                            <Text style={styles.body}>{i.merchant}</Text>
                            <Text style={styles.body}>
                              {money(i.amountMinor, op.currency ?? 'AUD')} / {i.cadence}
                            </Text>
                          </View>
                          <Button
                            label="Details"
                            secondary
                            onPress={() => setDetails(i)}
                          />
                        </View>
                      ))}
                      <Text style={styles.label}>
                        Total: {money(total, op.currency ?? 'AUD')}/mo
                      </Text>
                      {details && (
                        <View style={styles.details}>
                          <Text style={styles.label}>{details.merchant}</Text>
                          <Text style={styles.body}>
                            {money(details.amountMinor, op.currency ?? 'AUD')},{' '}
                            {details.cadence}
                          </Text>
                          <Text style={styles.body}>
                            Last seen {details.lastSeen}
                          </Text>
                          <Button
                            label="Close"
                            secondary
                            onPress={() => setDetails(null)}
                          />
                        </View>
                      )}
                      <Button label="Refresh" secondary onPress={() => controller.refresh()} />
                    </View>
                  )}

                  {deleting && (
                    <Text style={styles.body}>
                      Deletion requested. Not confirmed yet…
                    </Text>
                  )}
                  {deleted && (
                    <Text style={styles.body}>
                      Server confirmed: your import was deleted.
                    </Text>
                  )}

                  {!deleted && !deleting && (
                    <Button
                      label={op.deleteKey ? 'Retry delete' : 'Delete import'}
                      secondary
                      onPress={() => controller.remove()}
                      disabled={busy}
                    />
                  )}
                  {deleted && (
                    <Button label="Done" onPress={() => controller.dismiss()} />
                  )}
                </View>
              )}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: '700', color: '#111' },
  body: { fontSize: 16, color: '#222', marginVertical: 2 },
  label: { fontSize: 16, fontWeight: '700', color: '#111', marginVertical: 4 },
  notice: { fontSize: 16, color: '#8a1c1c', backgroundColor: '#fde8e8', padding: 10, borderRadius: 8 },
  spinner: { alignSelf: 'flex-start' },
  card: { borderWidth: 1, borderColor: '#ccc', borderRadius: 10, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginVertical: 4 },
  rowText: { flexGrow: 1, flexShrink: 1, minWidth: 140 },
  details: { backgroundColor: '#f3f6fb', padding: 10, borderRadius: 8, marginVertical: 6 },
  button: { backgroundColor: '#1553b8', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, minHeight: 44, justifyContent: 'center', marginVertical: 4 },
  buttonSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#1553b8' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  secondaryText: { color: '#1553b8' },
  disabled: { opacity: 0.5 },
});

export default App;
