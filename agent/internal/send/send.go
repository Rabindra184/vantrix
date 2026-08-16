// Package send posts batches of samples to PerfPortal.
package send

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/Rabindra184/vantrix/agent"
	"github.com/Rabindra184/vantrix/agent/internal/collect"
)

// batch is the wire body of POST /v1/telemetry.
//
// TWO FIELDS, AND THE ABSENCE IS THE DESIGN. There is no orgId and no
// projectId: the server reads both from the bearer token (spec §2). `host` is
// a free-text label, not a foreign key to anything — hostnames collide and
// change on ephemeral generators, so it is configurable and is the dimension
// every chart groups by.
type batch struct {
	Host    string           `json:"host"`
	Samples []collect.Sample `json:"samples"`
}

// Client posts to one endpoint with one token.
type Client struct {
	endpoint  string
	token     string
	hostLabel string
	http      *http.Client
}

// New returns a Client. endpoint is the API root (e.g. https://perf.example);
// the telemetry path is appended here so a misconfigured path cannot silently
// POST samples at some other route.
func New(endpoint, token, hostLabel string, httpClient *http.Client) *Client {
	return &Client{
		endpoint:  strings.TrimRight(endpoint, "/") + "/v1/telemetry",
		token:     token,
		hostLabel: hostLabel,
		http:      httpClient,
	}
}

// Post sends one batch. An empty batch is a no-op rather than an empty request:
// at a 1 s interval with a 10 s window, the flush timer fires on every quiet
// stretch and a request per tick would be pure noise on a machine whose load is
// the measurement.
//
// It does not retry. A rejected POST is the caller's to count and drop — see
// the bounded buffer in Task 2 and spec §5.
func (c *Client) Post(ctx context.Context, samples []collect.Sample) error {
	if len(samples) == 0 {
		return nil
	}

	body, err := json.Marshal(batch{Host: c.hostLabel, Samples: samples})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", agent.UserAgent())

	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// The status only. The response body may name internal infrastructure,
		// and this string is written to a log on a shared load generator.
		return fmt.Errorf("telemetry rejected: %s", res.Status)
	}
	return nil
}
